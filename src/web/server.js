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
    saveRawConfig
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

const RECIPIENT_PATTERN = /^\$\{(WA_RECIPIENT_[A-Z0-9_]+)\}$/;
const NTFY_TOPIC_KEY = 'WA_NTFY_TOPIC';
const NOTIFICATION_EVENTS = ['job.completed', 'job.failed', 'job.partial', 'whatsapp.disconnected'];

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
        nextRun: nextRun ? nextRun.toISOString() : null,
        lastRun
    };
}

function jobFromBody(body) {
    const id = String(body.id || '').trim();
    const schedule = String(body.schedule || '').trim();
    const recipient = String(body.recipientKey || '').trim();
    const message = String(body.message || '');
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
        whatsapp: {
            enabled: whatsapp.enabled === true,
            recipientKey: recipientKey(whatsapp.recipient),
            events: normalizeUiEvents(whatsapp.events || ['job.completed', 'job.failed', 'job.partial'])
        },
        ntfy: {
            enabled: ntfy.enabled === true,
            server: ntfy.server || 'https://ntfy.sh',
            topicConfigured: Boolean(topic),
            maskedTopic: maskSecret(topic),
            events: normalizeUiEvents(ntfy.events || ['job.completed', 'job.failed', 'job.partial', 'whatsapp.disconnected'])
        }
    };
}

function notificationsFromBody(body, currentRaw, envPath = '.env') {
    const whatsapp = body.whatsapp || {};
    const ntfy = body.ntfy || {};
    const recipient = String(whatsapp.recipientKey || '').trim();
    const topic = String(ntfy.topic || '').trim();
    const currentTopic = loadEnvValue(NTFY_TOPIC_KEY, envPath) || process.env[NTFY_TOPIC_KEY] || '';

    if (whatsapp.enabled && !recipient.startsWith('WA_RECIPIENT_')) {
        throw new Error('Select a WhatsApp notification recipient');
    }
    if (ntfy.enabled && !topic && !currentTopic) {
        throw new Error('Enter an ntfy topic');
    }
    if (topic) saveEnvValue(NTFY_TOPIC_KEY, topic, envPath);

    return {
        whatsapp: {
            enabled: whatsapp.enabled === true,
            recipient: recipient ? `\${${recipient}}` : currentRaw.notifications?.whatsapp?.recipient || '',
            events: normalizeUiEvents(whatsapp.events, ['job.completed', 'job.failed', 'job.partial'])
        },
        ntfy: {
            enabled: ntfy.enabled === true,
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
        notificationManager
    } = options;
    const app = express();
    const upload = createUpload();
    const streams = new Set();

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
    app.use(express.static(path.resolve('public')));

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
            startedAt: status.startedAt || null
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

    app.post('/api/notifications/test/:provider', async (request, response) => {
        try {
            if (!notificationManager) throw new Error('Notifications are not available');
            if (request.params.provider === 'whatsapp' && status.whatsapp !== 'ready') {
                throw new Error('WhatsApp is not ready');
            }
            await notificationManager.test(request.params.provider);
            response.json({ ok: true });
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
            raw.jobs = raw.jobs.filter((job) => job.id !== request.params.id);
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
        try {
            if (status.whatsapp !== 'ready') throw new Error('WhatsApp is not ready');
            const config = loadConfig(configPath, process.env);
            const job = config.jobs.find((candidate) => candidate.id === request.params.id);
            if (!job) return response.status(404).json({ error: 'Job not found' });
            key = `manual:${job.id}:${crypto.randomUUID()}`;
            await runJob(client, job, stateStore, key, {}, activity);
            return response.json({ ok: true });
        } catch (error) {
            if (key) stateStore.markRunFailed(key, new Date().toISOString());
            return sendJsonError(response, error, activity);
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
            deleteRecipient(request.params.key, envPath);
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
    recipientKey,
    notificationsFromBody,
    sanitizeUploadFilename,
    serializeNotifications,
    serializeJob,
    uniqueUploadFilename
};
