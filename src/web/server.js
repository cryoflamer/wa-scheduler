const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const cron = require('node-cron');
const {
    loadConfig,
    loadRawConfig,
    normalizeConfig,
    saveRawConfig,
    upgradeLegacyNotificationEvents
} = require('../config');
const {
    deleteRecipient,
    loadRecipients,
    maskNumber,
    saveRecipient
} = require('../recipients');
const { runJob } = require('../scheduler');
const { safeErrorMessage } = require('../activity');
const { loadEnvValue, maskSecret, saveEnvValue } = require('../env');
const { sendTextMessage } = require('../whatsapp');
const { createUiAuth, loginPagePath } = require('./auth');

const RECIPIENT_PATTERN = /^\$\{(WA_RECIPIENT_[A-Z0-9_]+)\}$/;
const NTFY_TOPIC_KEY = 'WA_NTFY_TOPIC';
const NTFY_TOPIC_PREFIX = 'wa-scheduler-';

function generateNtfyTopic() {
    return `${NTFY_TOPIC_PREFIX}${crypto.randomBytes(18).toString('hex')}`;
}

function ensureNtfyTopic(envPath = '.env') {
    const current = loadEnvValue(NTFY_TOPIC_KEY, envPath) || process.env[NTFY_TOPIC_KEY] || '';
    if (current) return current;
    return saveEnvValue(NTFY_TOPIC_KEY, generateNtfyTopic(), envPath);
}
const NOTIFICATION_EVENTS = [
    'job.completed',
    'job.failed',
    'job.partial',
    'job.catchup.started',
    'job.retry.scheduled',
    'job.recovered',
    'job.retry.exhausted',
    'job.manual.completed',
    'job.manual.failed',
    'job.manual.partial',
    'whatsapp.disconnected'
];

function decodeMultipartFilename(filename) {
    const value = String(filename || '');

    if ([...value].some((character) => character.codePointAt(0) > 0xFF)) {
        return value;
    }

    const decoded = Buffer.from(value, 'latin1').toString('utf8');
    return decoded.includes('\uFFFD') ? value : decoded;
}

function sanitizeUploadFilename(filename) {
    const decoded = decodeMultipartFilename(filename).normalize('NFC');
    const basename = path.posix.basename(decoded.replace(/\\/g, '/'));
    const sanitized = basename
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .trim();

    if (!sanitized || sanitized === '.' || sanitized === '..') {
        return 'document';
    }

    return sanitized;
}

function uniqueUploadFilename(directory, filename) {
    const original = sanitizeUploadFilename(filename);
    const extension = path.extname(original);
    const base = path.basename(original, extension) || 'document';
    let candidate = `${base}${extension}`;
    let suffix = 2;

    while (fs.existsSync(path.join(directory, candidate))) {
        candidate = `${base}-${suffix}${extension}`;
        suffix += 1;
    }

    return candidate;
}

function createUpload() {
    const directory = path.resolve('documents');
    fs.mkdirSync(directory, { recursive: true });

    return multer({
        storage: multer.diskStorage({
            destination: directory,
            filename: (_request, file, callback) => {
                callback(null, uniqueUploadFilename(directory, file.originalname));
            }
        }),
        limits: { fileSize: 100 * 1024 * 1024 }
    });
}

function recipientKey(value) {
    return String(value || '').match(RECIPIENT_PATTERN)?.[1] || '';
}

function serializeJob(job, runtime = {}) {
    const files = Array.isArray(job.files)
        ? job.files.map((file) => typeof file === 'string' ? { path: file, caption: '' } : file)
        : job.file
            ? [{ path: job.file, caption: job.caption || '' }]
            : [];

    const normalizedJob = runtime.normalizedJob || { ...job, files, message: job.message || '' };
    const nextRun = typeof runtime.schedulerManager?.getNextRun === 'function'
        ? runtime.schedulerManager.getNextRun(job.id)
        : null;
    const lastRun = typeof runtime.stateStore?.getLatestScheduledRun === 'function'
        ? runtime.stateStore.getLatestScheduledRun(normalizedJob)
        : null;

    return {
        id: job.id,
        schedule: job.schedule,
        enabled: job.enabled !== false,
        recipientKey: recipientKey(job.recipient),
        message: job.message || '',
        files,
        retry: job.retry || { attempts: 0, delayMinutes: 10 },
        nextRun: nextRun ? nextRun.toISOString() : null,
        lastRun
    };
}

function jobFromBody(body) {
    const id = String(body.id || '').trim();
    const schedule = String(body.schedule || '').trim();
    const recipient = String(body.recipientKey || '').trim();
    const message = String(body.message || '');
    const retryEnabled = body.retryEnabled === true;
    const retryAttempts = retryEnabled ? Number(body.retryAttempts) : 0;
    const retryDelayMinutes = Number(body.retryDelayMinutes || 10);
    const files = Array.isArray(body.files)
        ? body.files.map((file) => ({
            path: String(file.path || '').trim(),
            caption: String(file.caption || '')
        }))
        : [];

    if (!recipient.startsWith('WA_RECIPIENT_')) {
        throw new Error('Select a recipient');
    }
    if (!cron.validate(schedule)) {
        throw new Error(`Invalid cron schedule: ${schedule}`);
    }

    return {
        id,
        schedule,
        recipient: `\${${recipient}}`,
        enabled: body.enabled !== false,
        retry: { attempts: retryAttempts, delayMinutes: retryDelayMinutes },
        message,
        files
    };
}


function normalizeUiEvents(value, allowed = NOTIFICATION_EVENTS) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(String).filter((event) => allowed.includes(event)))];
}

function serializeNotifications(raw, envPath = '.env') {
    const whatsapp = raw.notifications?.whatsapp || {};
    const ntfy = raw.notifications?.ntfy || {};
    const topic = loadEnvValue(NTFY_TOPIC_KEY, envPath) || process.env[NTFY_TOPIC_KEY] || '';

    return {
        version: 4,
        whatsapp: {
            enabled: whatsapp.enabled === true,
            recipientKey: recipientKey(whatsapp.recipient),
            includeMessage: whatsapp.includeMessage === true,
            events: upgradeLegacyNotificationEvents(normalizeUiEvents(whatsapp.events || [
                'job.completed', 'job.failed', 'job.partial',
                'job.catchup.started', 'job.retry.scheduled', 'job.recovered', 'job.retry.exhausted',
                'job.manual.completed', 'job.manual.failed', 'job.manual.partial'
            ]), raw.notifications?.version)
        },
        ntfy: {
            enabled: ntfy.enabled === true,
            includeMessage: ntfy.includeMessage === true,
            server: ntfy.server || 'https://ntfy.sh',
            topicConfigured: Boolean(topic),
            maskedTopic: maskSecret(topic),
            includeMessage: ntfy.includeMessage === true,
            events: upgradeLegacyNotificationEvents(normalizeUiEvents(ntfy.events || [
                'job.completed', 'job.failed', 'job.partial',
                'job.catchup.started', 'job.retry.scheduled', 'job.recovered', 'job.retry.exhausted',
                'job.manual.completed', 'job.manual.failed', 'job.manual.partial',
                'whatsapp.disconnected'
            ]), raw.notifications?.version)
        }
    };
}

function notificationsFromBody(body, currentRaw, envPath = '.env') {
    const whatsapp = body.whatsapp || {};
    const ntfy = body.ntfy || {};
    const recipient = String(whatsapp.recipientKey || '').trim();
    const currentTopic = loadEnvValue(NTFY_TOPIC_KEY, envPath) || process.env[NTFY_TOPIC_KEY] || '';

    if (whatsapp.enabled && !recipient.startsWith('WA_RECIPIENT_')) {
        throw new Error('Select a WhatsApp notification recipient');
    }
    if (ntfy.enabled && !currentTopic) {
        ensureNtfyTopic(envPath);
    }

    return {
        version: 4,
        whatsapp: {
            enabled: whatsapp.enabled === true,
            includeMessage: whatsapp.includeMessage === true,
            recipient: recipient ? `\${${recipient}}` : currentRaw.notifications?.whatsapp?.recipient || '',
            events: normalizeUiEvents(whatsapp.events, [
                'job.completed', 'job.failed', 'job.partial',
                'job.catchup.started', 'job.retry.scheduled', 'job.recovered', 'job.retry.exhausted',
                'job.manual.completed', 'job.manual.failed', 'job.manual.partial'
            ])
        },
        ntfy: {
            enabled: ntfy.enabled === true,
            includeMessage: ntfy.includeMessage === true,
            server: String(ntfy.server || 'https://ntfy.sh').trim(),
            topic: '${WA_NTFY_TOPIC}',
            events: normalizeUiEvents(ntfy.events)
        }
    };
}

function sendJsonError(response, error, activity = null) {
    if (activity) {
        activity.error('ui.request.failed', { error });
    } else {
        console.error('UI request failed:', error);
    }
    response.status(400).json({ error: safeErrorMessage(error) });
}

function createWebServer(options) {
    const {
        client,
        stateStore,
        schedulerManager,
        configPath = process.env.WA_SCHEDULE_CONFIG || 'schedule.json',
        envPath = '.env',
        status,
        activity,
        notificationManager,
        uiAuth: uiAuthConfig = { enabled: false, password: '' }
    } = options;
    const app = express();
    const upload = createUpload();
    const streams = new Set();
    const uiAuth = createUiAuth({ ...uiAuthConfig, activity });

    function applyConfig(config) {
        schedulerManager.apply(config);
        notificationManager?.apply(config.notifications);
    }

    app.closeStreams = () => {
        for (const response of streams) {
            response.end();
        }
        streams.clear();
    };

    app.use(express.json({ limit: '1mb' }));

    app.get('/login', (request, response) => {
        if (!uiAuth.enabled || uiAuth.isAuthenticated(request)) return response.redirect(303, '/');
        return response.sendFile(loginPagePath());
    });

    app.post('/api/auth/login', (request, response) => {
        const result = uiAuth.signIn(request, response, String(request.body?.password || ''));
        return response.status(result.ok ? 200 : result.status).json(result);
    });

    app.use(uiAuth.middleware);
    app.use(express.static(path.resolve('public')));

    app.post('/api/auth/logout', (request, response) => {
        uiAuth.signOut(request, response);
        response.json({ ok: true });
    });

    app.get('/api/activity', (request, response) => {
        if (!activity) return response.json([]);
        return response.json(activity.list({
            limit: request.query.limit,
            filter: request.query.filter
        }));
    });

    app.delete('/api/activity', (_request, response) => {
        activity?.clear();
        response.json({ ok: true });
    });

    app.get('/api/activity/stream', (request, response) => {
        response.setHeader('Content-Type', 'text/event-stream');
        response.setHeader('Cache-Control', 'no-cache');
        response.setHeader('Connection', 'keep-alive');
        response.flushHeaders?.();
        streams.add(response);

        const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
        const sendClear = () => response.write('event: clear\ndata: {}\n\n');
        const unsubscribe = activity?.subscribe(send) || (() => {});
        const unsubscribeClear = activity?.onClear(sendClear) || (() => {});
        const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 25000);

        request.on('close', () => {
            streams.delete(response);
            clearInterval(keepAlive);
            unsubscribe();
            unsubscribeClear();
        });
    });

    app.get('/api/status', (_request, response) => {
        response.json({
            whatsapp: status.whatsapp,
            timezone: schedulerManager.config?.timezone || null,
            jobs: schedulerManager.config?.jobs.length || 0,
            activeJobs: schedulerManager.tasks.length,
            startedAt: status.startedAt || null,
            activityRetentionDays: activity?.retentionDays || 30,
            uiAuthEnabled: uiAuth.enabled
        });
    });

    app.get('/api/notifications', (_request, response) => {
        const raw = loadRawConfig(configPath);
        response.json(serializeNotifications(raw, envPath));
    });

    app.put('/api/notifications', (request, response) => {
        try {
            const raw = loadRawConfig(configPath);
            raw.notifications = notificationsFromBody(request.body, raw, envPath);
            const normalized = normalizeConfig(raw, process.env);
            saveRawConfig(raw, configPath);
            applyConfig(normalized);
            response.json(serializeNotifications(raw, envPath));
        } catch (error) {
            sendJsonError(response, error, activity);
        }
    });

    app.post('/api/notifications/ntfy/topic/regenerate', (request, response) => {
        try {
            const topic = saveEnvValue(NTFY_TOPIC_KEY, generateNtfyTopic(), envPath);
            const raw = loadRawConfig(configPath);
            raw.notifications ||= {};
            raw.notifications.ntfy ||= {};
            raw.notifications.ntfy.topic = '${WA_NTFY_TOPIC}';
            const normalized = normalizeConfig(raw, process.env);
            saveRawConfig(raw, configPath);
            applyConfig(normalized);
            activity?.sent('notification.ntfy_topic.regenerated', {
                message: 'ntfy topic regenerated'
            });
            response.json({
                ok: true,
                topicConfigured: true,
                maskedTopic: maskSecret(topic),
                message: 'ntfy topic regenerated'
            });
        } catch (error) {
            sendJsonError(response, error, activity);
        }
    });

    app.post('/api/notifications/ntfy/topic/send', async (request, response) => {
        try {
            if (status.whatsapp !== 'ready') {
                throw new Error('WhatsApp is not ready');
            }

            const recipientKeyValue = String(request.body?.recipientKey || '').trim();
            const recipient = loadRecipients(envPath).find((candidate) => candidate.key === recipientKeyValue);
            if (!recipient) {
                throw new Error('Select a recipient for the ntfy topic');
            }

            const raw = loadRawConfig(configPath);
            const topic = loadEnvValue(NTFY_TOPIC_KEY, envPath) || process.env[NTFY_TOPIC_KEY] || '';
            if (!topic) {
                throw new Error('Enable ntfy to generate a topic first');
            }

            const server = raw.notifications?.ntfy?.server || 'https://ntfy.sh';
            const message = [
                '🔔 ntfy topic for wa-scheduler',
                '',
                `Server: ${server}`,
                `Topic: ${topic}`,
                '',
                'Copy the topic and subscribe to it in the ntfy app.'
            ].join('\n');

            await sendTextMessage(client, recipient.number, message);
            activity?.sent('notification.ntfy_topic.sent', {
                message: `ntfy topic sent to ${recipient.name}`,
                details: { recipient: recipient.name }
            });

            return response.json({
                ok: true,
                recipient: recipient.name,
                message: `ntfy topic sent to ${recipient.name}`
            });
        } catch (error) {
            return sendJsonError(response, error, activity);
        }
    });

    app.post('/api/notifications/test/:provider', async (request, response) => {
        try {
            if (!notificationManager) throw new Error('Notifications are not available');
            if (request.params.provider === 'whatsapp' && status.whatsapp !== 'ready') {
                throw new Error('WhatsApp is not ready');
            }
            const provider = request.params.provider;
            const result = await notificationManager.test(provider);
            response.json({
                ok: true,
                provider,
                accepted: result?.accepted !== false,
                testId: result?.testId || null,
                publishedAt: result?.publishedAt || null,
                messageId: result?.id || null,
                message: provider === 'ntfy'
                    ? result?.id
                        ? `Published to ntfy · Message ID: ${result.id} · Test ID: ${result.testId}`
                        : `Published to ntfy · Test ID: ${result?.testId || 'unknown'}`
                    : `Test notification sent to WhatsApp · Test ID: ${result?.testId || 'unknown'}`
            });
        } catch (error) {
            sendJsonError(response, error, activity);
        }
    });

    app.get('/api/jobs', (_request, response) => {
        const raw = loadRawConfig(configPath);
        const normalized = loadConfig(configPath, process.env);
        response.json({
            timezone: raw.timezone,
            jobs: raw.jobs.map((job, index) => serializeJob(job, {
                schedulerManager,
                stateStore,
                normalizedJob: normalized.jobs[index]
            }))
        });
    });

    app.post('/api/jobs', (request, response) => {
        try {
            const raw = loadRawConfig(configPath);
            raw.jobs.push(jobFromBody(request.body));
            const normalized = normalizeConfig(raw, process.env);
            saveRawConfig(raw, configPath);
            applyConfig(normalized);
            response.status(201).json({ ok: true });
        } catch (error) {
            sendJsonError(response, error, activity);
        }
    });

    app.put('/api/jobs/:id', (request, response) => {
        try {
            const raw = loadRawConfig(configPath);
            const index = raw.jobs.findIndex((job) => job.id === request.params.id);
            if (index < 0) {
                return response.status(404).json({ error: 'Job not found' });
            }

            raw.jobs[index] = jobFromBody(request.body);
            const normalized = normalizeConfig(raw, process.env);
            saveRawConfig(raw, configPath);
            applyConfig(normalized);
            return response.json({ ok: true });
        } catch (error) {
            return sendJsonError(response, error, activity);
        }
    });


    app.post('/api/jobs/:id/toggle', (request, response) => {
        try {
            const raw = loadRawConfig(configPath);
            const job = raw.jobs.find((candidate) => candidate.id === request.params.id);
            if (!job) return response.status(404).json({ error: 'Job not found' });
            job.enabled = job.enabled === false;
            const normalized = normalizeConfig(raw, process.env);
            saveRawConfig(raw, configPath);
            applyConfig(normalized);
            return response.json({ ok: true, enabled: job.enabled });
        } catch (error) {
            return sendJsonError(response, error, activity);
        }
    });

    app.delete('/api/jobs/:id', (request, response) => {
        try {
            const raw = loadRawConfig(configPath);
            const job = raw.jobs.find((candidate) => candidate.id === request.params.id);
            if (!job) return response.status(404).json({ error: 'Job not found' });
            if (schedulerManager?.isJobActive?.(job.id)) {
                throw new Error('Job is currently running');
            }

            stateStore.cancelPendingRetriesForJob?.(
                job.id,
                new Date().toISOString(),
                'job deleted'
            );
            raw.jobs = raw.jobs.filter((candidate) => candidate.id !== job.id);
            const normalized = normalizeConfig(raw, process.env);
            saveRawConfig(raw, configPath);
            applyConfig(normalized);
            response.json({ ok: true });
        } catch (error) {
            sendJsonError(response, error, activity);
        }
    });

    app.post('/api/jobs/:id/send', async (request, response) => {
        let key = null;
        let lockedJobId = null;
        let runJobSnapshot = null;
        try {
            if (status.whatsapp !== 'ready') throw new Error('WhatsApp is not ready');
            const config = loadConfig(configPath, process.env);
            const job = config.jobs.find((candidate) => candidate.id === request.params.id);
            if (!job) return response.status(404).json({ error: 'Job not found' });
            if (schedulerManager?.beginManualRun && !schedulerManager.beginManualRun(job.id)) {
                throw new Error('Job is currently running');
            }
            lockedJobId = job.id;
            key = `manual:${job.id}:${crypto.randomUUID()}`;
            runJobSnapshot = stateStore.captureRunSnapshot?.(key, job) || job;
            await runJob(client, runJobSnapshot, stateStore, key, {}, activity);
            if (notificationManager) {
                const progress = stateStore.getRunDetails(key, runJobSnapshot);
                await notificationManager.notify('job.manual.completed', {
                    job: runJobSnapshot,
                    sentItems: progress.sentItems,
                    progress,
                    idempotencyKey: key
                });
            }
            return response.json({ ok: true });
        } catch (error) {
            if (key) {
                stateStore.markRunFailed(key, new Date().toISOString());
                if (notificationManager && runJobSnapshot) {
                    const progress = stateStore.getRunDetails(key, runJobSnapshot);
                    const type = progress.sentItems > 0 && progress.sentItems < progress.totalItems
                        ? 'job.manual.partial'
                        : 'job.manual.failed';
                    await notificationManager.notify(type, {
                            job: runJobSnapshot,
                            error,
                            sentItems: progress.sentItems,
                            progress,
                            idempotencyKey: key
                        });
                }
            }
            return sendJsonError(response, error, activity);
        } finally {
            if (lockedJobId) schedulerManager?.endManualRun?.(lockedJobId);
        }
    });

    app.get('/api/recipients', (_request, response) => {
        response.json(loadRecipients(envPath).map((recipient) => ({
            key: recipient.key,
            name: recipient.name,
            maskedNumber: maskNumber(recipient.number)
        })));
    });

    app.post('/api/recipients', (request, response) => {
        try {
            const recipient = saveRecipient(request.body.name, request.body.number, envPath);
            applyConfig(loadConfig(configPath, process.env));
            response.status(201).json({
                key: recipient.key,
                name: recipient.name,
                maskedNumber: maskNumber(recipient.number)
            });
        } catch (error) {
            sendJsonError(response, error, activity);
        }
    });

    app.delete('/api/recipients/:key', (request, response) => {
        try {
            const raw = loadRawConfig(configPath);
            const reference = `\${${request.params.key}}`;
            if (raw.jobs.some((job) => job.recipient === reference)) {
                throw new Error('Recipient is used by a job');
            }
            if (raw.notifications?.whatsapp?.recipient === reference) {
                throw new Error('Recipient is used by WhatsApp notifications');
            }
            deleteRecipient(request.params.key, envPath);
            applyConfig(loadConfig(configPath, process.env));
            response.json({ ok: true });
        } catch (error) {
            sendJsonError(response, error, activity);
        }
    });

    app.post('/api/files', upload.single('file'), (request, response) => {
        if (!request.file) {
            return response.status(400).json({ error: 'Select a file' });
        }

        return response.status(201).json({
            path: path.posix.join('documents', request.file.filename),
            name: request.file.filename
        });
    });

    return app;
}

module.exports = {
    createWebServer,
    ensureNtfyTopic,
    generateNtfyTopic,
    recipientKey,
    notificationsFromBody,
    sanitizeUploadFilename,
    serializeNotifications,
    serializeJob,
    uniqueUploadFilename,
    jobFromBody
};
