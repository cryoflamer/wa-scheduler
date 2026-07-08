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

const RECIPIENT_PATTERN = /^\$\{(WA_RECIPIENT_[A-Z0-9_]+)\}$/;

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

function serializeJob(job) {
    const files = Array.isArray(job.files)
        ? job.files.map((file) => typeof file === 'string' ? { path: file, caption: '' } : file)
        : job.file
            ? [{ path: job.file, caption: job.caption || '' }]
            : [];

    return {
        id: job.id,
        schedule: job.schedule,
        recipientKey: recipientKey(job.recipient),
        message: job.message || '',
        files
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
        message,
        files
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
        activity
    } = options;
    const app = express();
    const upload = createUpload();

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

        const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
        const sendClear = () => response.write('event: clear\ndata: {}\n\n');
        const unsubscribe = activity?.subscribe(send) || (() => {});
        const unsubscribeClear = activity?.onClear(sendClear) || (() => {});
        const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 25000);

        request.on('close', () => {
            clearInterval(keepAlive);
            unsubscribe();
            unsubscribeClear();
        });
    });

    app.get('/api/status', (_request, response) => {
        response.json({
            whatsapp: status.whatsapp,
            timezone: schedulerManager.config?.timezone || null,
            jobs: schedulerManager.config?.jobs.length || 0
        });
    });

    app.get('/api/jobs', (_request, response) => {
        const raw = loadRawConfig(configPath);
        response.json({ timezone: raw.timezone, jobs: raw.jobs.map(serializeJob) });
    });

    app.post('/api/jobs', (request, response) => {
        try {
            const raw = loadRawConfig(configPath);
            raw.jobs.push(jobFromBody(request.body));
            const normalized = normalizeConfig(raw, process.env);
            saveRawConfig(raw, configPath);
            schedulerManager.apply(normalized);
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
            schedulerManager.apply(normalized);
            return response.json({ ok: true });
        } catch (error) {
            return sendJsonError(response, error, activity);
        }
    });

    app.delete('/api/jobs/:id', (request, response) => {
        try {
            const raw = loadRawConfig(configPath);
            raw.jobs = raw.jobs.filter((job) => job.id !== request.params.id);
            if (raw.jobs.length === 0) {
                throw new Error('At least one job must remain');
            }
            const normalized = normalizeConfig(raw, process.env);
            saveRawConfig(raw, configPath);
            schedulerManager.apply(normalized);
            response.json({ ok: true });
        } catch (error) {
            sendJsonError(response, error, activity);
        }
    });

    app.post('/api/jobs/:id/send', async (request, response) => {
        try {
            if (status.whatsapp !== 'ready') {
                throw new Error('WhatsApp is not ready');
            }

            const config = loadConfig(configPath, process.env);
            const job = config.jobs.find((candidate) => candidate.id === request.params.id);
            if (!job) {
                return response.status(404).json({ error: 'Job not found' });
            }

            const key = `manual:${job.id}:${crypto.randomUUID()}`;
            await runJob(client, job, stateStore, key, {}, activity);
            return response.json({ ok: true });
        } catch (error) {
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
            schedulerManager.apply(loadConfig(configPath, process.env));
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
    sanitizeUploadFilename,
    serializeJob,
    uniqueUploadFilename
};
