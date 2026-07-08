const path = require('path');
const cron = require('node-cron');
const { sendDocument, sendTextMessage } = require('./whatsapp');
const { dateKey, occurrenceKey } = require('./run_identity');

function report(activity, method, type, fields, fallback) {
    if (activity) {
        activity[method](type, fields);
    } else if (method === 'error') {
        console.error(fallback || fields.message);
    } else if (method === 'skipped') {
        console.warn(fallback || fields.message);
    } else {
        console.log(fallback || fields.message);
    }
}

async function runJob(
    client,
    job,
    stateStore,
    key,
    senders = {},
    activity = null,
    notifications = null,
    options = {}
) {
    const sendText = senders.sendText || sendTextMessage;
    const sendFile = senders.sendFile || sendDocument;
    const completionType = options.completionType || 'job.completed';
    const completionMessage = completionType === 'job.recovered'
        ? `Job recovered on retry ${options.retryAttempt} of ${options.maxRetries}`
        : 'Job completed';

    if (stateStore.isComplete(key)) {
        report(activity, 'skipped', 'job.skipped', {
            jobId: job.id,
            message: 'Already sent for this occurrence; skipping'
        }, `Job ${job.id} already sent for this occurrence; skipping`);
        return { status: 'skipped' };
    }

    stateStore.markRunStarted(key, new Date().toISOString());
    report(activity, 'info', options.retryAttempt ? 'job.retry.started' : 'job.started', {
        jobId: job.id,
        message: options.retryAttempt
            ? `Retry ${options.retryAttempt} of ${options.maxRetries} started`
            : 'Job started',
        ...(options.retryAttempt ? { details: { retryAttempt: options.retryAttempt, maxRetries: options.maxRetries } } : {})
    }, options.retryAttempt
        ? `Job ${job.id} retry ${options.retryAttempt} of ${options.maxRetries} started`
        : `Job ${job.id} started`);

    if (job.message && !stateStore.isMessageSent(key)) {
        await sendText(client, job.recipient, job.message);
        stateStore.markMessageSent(key, new Date().toISOString());
        report(activity, 'sent', 'job.message.sent', {
            jobId: job.id,
            message: 'Message sent'
        }, `Job ${job.id} message sent`);
    }

    for (const file of job.files) {
        if (stateStore.isFileSent(key, file.path)) {
            continue;
        }

        await sendFile(client, job.recipient, file);
        stateStore.markFileSent(key, file.path, new Date().toISOString());
        const filename = path.basename(file.path);
        report(activity, 'sent', 'job.file.sent', {
            jobId: job.id,
            message: `${filename} sent`,
            details: { file: filename }
        }, `Job ${job.id} file sent: ${file.path}`);
    }

    stateStore.markComplete(key, new Date().toISOString());
    report(activity, 'sent', completionType, {
        jobId: job.id,
        message: completionMessage,
        ...(options.retryAttempt ? { details: { retryAttempt: options.retryAttempt, maxRetries: options.maxRetries } } : {})
    }, completionType === 'job.recovered'
        ? `Job ${job.id} recovered on retry ${options.retryAttempt} of ${options.maxRetries}`
        : `Job ${job.id} completed`);

    if (notifications) {
        const progress = stateStore.getRunDetails(key, job);
        await notifications.notify(completionType, {
            job,
            sentItems: progress.sentItems,
            progress,
            idempotencyKey: key,
            retryAttempt: options.retryAttempt || 0,
            maxRetries: options.maxRetries || 0
        });
    }

    return { status: 'sent' };
}

function retryPolicy(job) {
    return {
        attempts: Number(job?.retry?.attempts || 0),
        delayMinutes: Number(job?.retry?.delayMinutes || 10)
    };
}

function failureType(progress) {
    return progress.sentItems > 0 && progress.sentItems < progress.totalItems ? 'job.partial' : 'job.failed';
}

async function runLegacyScheduled(client, job, stateStore, key, activity, notifications) {
    try {
        await runJob(client, job, stateStore, key, {}, activity, notifications);
    } catch (error) {
        stateStore.markRunFailed(key, new Date().toISOString());
        report(activity, 'error', 'job.failed', {
            jobId: job.id,
            error
        }, `Job ${job.id} failed: ${error.message}`);
        if (notifications) {
            const progress = stateStore.getRunDetails(key, job);
            await notifications.notify(failureType(progress), {
                job,
                error,
                sentItems: progress.sentItems,
                progress,
                idempotencyKey: key
            });
        }
    }
}

function registerJobs(client, config, stateStore, activity = null, notifications = null, runScheduled = null) {
    for (const job of config.jobs) {
        if (!cron.validate(job.schedule)) {
            throw new Error(`Invalid cron schedule for job ${job.id}: ${job.schedule}`);
        }
    }

    const tasks = [];

    for (const job of config.jobs) {
        if (!job.enabled) {
            report(activity, 'info', 'job.disabled', {
                jobId: job.id,
                message: 'Job disabled'
            }, `Job ${job.id} disabled`);
            continue;
        }

        const task = cron.schedule(
            job.schedule,
            async () => {
                const key = occurrenceKey(job.id, new Date(), config.timezone);
                if (runScheduled) {
                    await runScheduled(job, key, config);
                } else {
                    stateStore.migrateLegacyScheduledRun?.(key, job.id);
                    await runLegacyScheduled(client, job, stateStore, key, activity, notifications);
                }
            },
            {
                timezone: config.timezone,
                noOverlap: true
            }
        );

        tasks.push({ jobId: job.id, task });
        report(activity, 'info', 'job.scheduled', {
            jobId: job.id,
            message: `Scheduled: ${job.schedule} (${config.timezone})`
        }, `Job ${job.id} scheduled: ${job.schedule} (${config.timezone})`);
    }

    return tasks;
}

class SchedulerManager {
    constructor(client, stateStore, activity = null, notifications = null, options = {}) {
        this.client = client;
        this.stateStore = stateStore;
        this.activity = activity;
        this.notifications = notifications;
        this.tasks = [];
        this.config = null;
        this.retryTimers = new Map();
        this.activeRunKeys = new Set();
        this.activeJobIds = new Set();
        this.setTimeout = options.setTimeout || setTimeout;
        this.clearTimeout = options.clearTimeout || clearTimeout;
        this.now = options.now || (() => new Date());
    }

    apply(config) {
        this.notifications?.apply(config.notifications);
        this.stop();
        this.config = config;
        this.tasks = registerJobs(
            this.client,
            config,
            this.stateStore,
            this.activity,
            this.notifications,
            (job, key) => this.executeScheduled(job, key, 0)
        );
        this.resumePendingRetries();
    }

    async executeScheduled(job, key, retryAttempt = 0) {
        if (retryAttempt === 0) {
            this.stateStore.migrateLegacyScheduledRun?.(key, job.id);
            const unresolved = this.stateStore.findUnresolvedScheduledRun?.(job.id, key);
            if (unresolved) {
                report(this.activity, 'skipped', 'job.occurrence.blocked', {
                    jobId: job.id,
                    message: 'Previous scheduled run is still unfinished',
                    details: { previousRunKey: unresolved.key, previousStatus: unresolved.status }
                }, `Job ${job.id} has an unfinished previous run; skipping new occurrence`);
                return { status: 'blocked', previousRunKey: unresolved.key };
            }
        }

        if (this.activeRunKeys.has(key) || this.activeJobIds.has(job.id)) {
            report(this.activity, 'skipped', 'job.retry.overlap', {
                jobId: job.id,
                message: 'Job already active; skipping overlapping attempt'
            }, `Job ${job.id} already active; skipping`);
            return { status: 'overlap' };
        }

        const runJobSnapshot = this.stateStore.captureRunSnapshot?.(key, job) || job;
        this.activeRunKeys.add(key);
        this.activeJobIds.add(job.id);
        try {
            const policy = retryPolicy(runJobSnapshot);
            const maxRetries = policy.attempts;
            const result = await runJob(
                this.client,
                runJobSnapshot,
                this.stateStore,
                key,
                {},
                this.activity,
                this.notifications,
                retryAttempt > 0
                    ? { completionType: 'job.recovered', retryAttempt, maxRetries }
                    : {}
            );
            this.clearRetryTimer(key);
            return result;
        } catch (error) {
            const failedAt = this.now().toISOString();
            this.stateStore.markRunFailed(key, failedAt);
            const progress = this.stateStore.getRunDetails(key, runJobSnapshot);
            const policy = retryPolicy(runJobSnapshot);
            const maxRetries = policy.attempts;

            report(this.activity, 'error', retryAttempt > 0 ? 'job.retry.failed' : 'job.failed', {
                jobId: job.id,
                error,
                ...(retryAttempt > 0 ? { details: { retryAttempt, maxRetries } } : {})
            }, retryAttempt > 0
                ? `Job ${job.id} retry ${retryAttempt} of ${maxRetries} failed: ${error.message}`
                : `Job ${job.id} failed: ${error.message}`);

            if (retryAttempt < maxRetries) {
                const nextAttempt = retryAttempt + 1;
                const nextRetryAt = new Date(this.now().getTime() + policy.delayMinutes * 60_000).toISOString();
                this.stateStore.markRetryScheduled(key, nextAttempt, nextRetryAt);
                report(this.activity, 'info', 'job.retry.scheduled', {
                    jobId: job.id,
                    message: `Retry ${nextAttempt} of ${maxRetries} scheduled in ${policy.delayMinutes} minutes`,
                    details: { retryAttempt: nextAttempt, maxRetries, nextRetryAt }
                }, `Job ${job.id} retry ${nextAttempt} of ${maxRetries} scheduled in ${policy.delayMinutes} minutes`);

                if (this.notifications) {
                    await this.notifications.notify('job.retry.scheduled', {
                        job: runJobSnapshot,
                        error,
                        sentItems: progress.sentItems,
                        progress,
                        idempotencyKey: key,
                        retryAttempt: nextAttempt,
                        maxRetries,
                        delayMinutes: policy.delayMinutes
                    });
                }

                this.scheduleRetry(runJobSnapshot, key, nextAttempt, nextRetryAt);
                return { status: 'retrying', retryAttempt: nextAttempt, nextRetryAt };
            }

            this.stateStore.clearRetry(key);
            if (this.notifications) {
                const type = maxRetries > 0 ? 'job.retry.exhausted' : failureType(progress);
                await this.notifications.notify(type, {
                    job: runJobSnapshot,
                    error,
                    sentItems: progress.sentItems,
                    progress,
                    idempotencyKey: key,
                    retryAttempt,
                    maxRetries
                });
            }
            return { status: 'failed', error };
        } finally {
            this.activeRunKeys.delete(key);
            this.activeJobIds.delete(job.id);
        }
    }

    scheduleRetry(job, key, retryAttempt, nextRetryAt) {
        this.clearRetryTimer(key);
        const delay = Math.max(0, new Date(nextRetryAt).getTime() - this.now().getTime());
        const timer = this.setTimeout(() => {
            this.retryTimers.delete(key);
            void this.executeScheduled(job, key, retryAttempt);
        }, delay);
        timer?.unref?.();
        this.retryTimers.set(key, timer);
    }

    resumePendingRetries() {
        if (!this.config) return;
        const jobsById = new Map(this.config.jobs.filter((job) => job.enabled).map((job) => [job.id, job]));
        for (const pending of this.stateStore.listPendingRetries()) {
            const currentJob = jobsById.get(pending.jobId);
            if (!currentJob) continue;
            const runJobSnapshot = this.stateStore.getRunSnapshot?.(pending.key) || this.stateStore.captureRunSnapshot?.(pending.key, currentJob) || currentJob;
            if (pending.retryAttempt > retryPolicy(runJobSnapshot).attempts) continue;
            this.scheduleRetry(runJobSnapshot, pending.key, pending.retryAttempt, pending.nextRetryAt);
            report(this.activity, 'info', 'job.retry.resumed', {
                jobId: currentJob.id,
                message: `Retry ${pending.retryAttempt} of ${retryPolicy(runJobSnapshot).attempts} resumed`,
                details: {
                    retryAttempt: pending.retryAttempt,
                    maxRetries: retryPolicy(runJobSnapshot).attempts,
                    nextRetryAt: pending.nextRetryAt
                }
            }, `Job ${currentJob.id} retry ${pending.retryAttempt} resumed`);
        }
    }

    beginManualRun(jobId) {
        if (this.activeJobIds.has(jobId)) return false;
        this.activeJobIds.add(jobId);
        return true;
    }

    endManualRun(jobId) {
        this.activeJobIds.delete(jobId);
    }

    isJobActive(jobId) {
        return this.activeJobIds.has(jobId);
    }

    getNextRun(jobId) {
        return this.tasks.find((entry) => entry.jobId === jobId)?.task.getNextRun() || null;
    }

    clearRetryTimer(key) {
        const timer = this.retryTimers.get(key);
        if (timer) this.clearTimeout(timer);
        this.retryTimers.delete(key);
    }

    stop() {
        for (const { task } of this.tasks) {
            task.destroy();
        }
        this.tasks = [];
        for (const key of [...this.retryTimers.keys()]) this.clearRetryTimer(key);
    }
}

module.exports = {
    dateKey,
    occurrenceKey,
    registerJobs,
    runJob,
    SchedulerManager
};
