const path = require('path');
const cron = require('node-cron');
const { sendDocument, sendTextMessage } = require('./whatsapp');

function dateKey(date, timezone) {
    const parts = new Intl.DateTimeFormat('en', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));

    return `${values.year}-${values.month}-${values.day}`;
}

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

async function runJob(client, job, stateStore, key, senders = {}, activity = null) {
    const sendText = senders.sendText || sendTextMessage;
    const sendFile = senders.sendFile || sendDocument;

    if (stateStore.isComplete(key)) {
        report(activity, 'skipped', 'job.skipped', {
            jobId: job.id,
            message: 'Already sent for this date; skipping'
        }, `Job ${job.id} already sent for this date; skipping`);
        return { status: 'skipped' };
    }

    stateStore.markRunStarted(key, new Date().toISOString());
    report(activity, 'info', 'job.started', {
        jobId: job.id,
        message: 'Job started'
    }, `Job ${job.id} started`);

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
    report(activity, 'sent', 'job.completed', {
        jobId: job.id,
        message: 'Job completed'
    }, `Job ${job.id} completed`);

    return { status: 'sent' };
}

function registerJobs(client, config, stateStore, activity = null) {
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
                const now = new Date();
                const key = `${job.id}:${dateKey(now, config.timezone)}`;

                try {
                    await runJob(client, job, stateStore, key, {}, activity);
                } catch (error) {
                    stateStore.markRunFailed(key, new Date().toISOString());
                    report(activity, 'error', 'job.failed', {
                        jobId: job.id,
                        error
                    }, `Job ${job.id} failed: ${error.message}`);
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
    constructor(client, stateStore, activity = null) {
        this.client = client;
        this.stateStore = stateStore;
        this.activity = activity;
        this.tasks = [];
        this.config = null;
    }

    apply(config) {
        const nextTasks = registerJobs(this.client, config, this.stateStore, this.activity);
        this.stop();
        this.tasks = nextTasks;
        this.config = config;
    }

    getNextRun(jobId) {
        return this.tasks.find((entry) => entry.jobId === jobId)?.task.getNextRun() || null;
    }

    stop() {
        for (const { task } of this.tasks) {
            task.destroy();
        }
        this.tasks = [];
    }
}

module.exports = {
    dateKey,
    registerJobs,
    runJob,
    SchedulerManager
};
