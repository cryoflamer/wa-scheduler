const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { ActivityLog } = require('../src/activity');
const { loadConfig } = require('../src/config');
const { createWebServer } = require('../src/web/server');

test('local UI API returns jobs and masked recipients', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-web-api-'));
    const configPath = path.join(directory, 'schedule.json');
    const envPath = path.join(directory, '.env');
    fs.writeFileSync(configPath, JSON.stringify({
        timezone: 'Europe/Kyiv',
        jobs: [{
            id: 'report',
            schedule: '0 8 * * 1',
            recipient: '${WA_RECIPIENT_OFFICE}',
            message: 'Report'
        }]
    }));
    fs.writeFileSync(envPath, 'WA_RECIPIENT_OFFICE=380661234567\n');
    process.env.WA_RECIPIENT_OFFICE = '380661234567';

    const activity = new ActivityLog(path.join(directory, 'activity.jsonl'));
    const originalLog = console.log;
    console.log = () => {};
    activity.info('whatsapp.ready', { message: 'WhatsApp ready' });
    activity.sent('job.completed', { jobId: 'report', message: 'Job completed' });
    console.log = originalLog;

    const schedulerManager = {
        config: loadConfig(configPath),
        apply(config) { this.config = config; }
    };
    const app = createWebServer({
        client: {},
        stateStore: {},
        schedulerManager,
        configPath,
        envPath,
        status: { whatsapp: 'ready' },
        activity
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => {
        server.close();
        delete process.env.WA_RECIPIENT_OFFICE;
    });
    const { port } = server.address();

    const jobs = await fetch(`http://127.0.0.1:${port}/api/jobs`).then((response) => response.json());
    const recipients = await fetch(`http://127.0.0.1:${port}/api/recipients`).then((response) => response.json());
    const activityEvents = await fetch(`http://127.0.0.1:${port}/api/activity?filter=jobs`).then((response) => response.json());

    assert.equal(jobs.jobs[0].recipientKey, 'WA_RECIPIENT_OFFICE');
    assert.deepEqual(activityEvents.map((event) => event.type), ['job.completed']);
    assert.deepEqual(recipients, [{
        key: 'WA_RECIPIENT_OFFICE',
        name: 'OFFICE',
        maskedNumber: '380******567'
    }]);
});

test('activity SSE streams new events and clear notifications', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-web-activity-'));
    const configPath = path.join(directory, 'schedule.json');
    const activity = new ActivityLog(path.join(directory, 'activity.jsonl'));
    fs.writeFileSync(configPath, JSON.stringify({
        timezone: 'Europe/Kyiv',
        jobs: [{
            id: 'report',
            schedule: '0 8 * * 1',
            recipient: '${WA_RECIPIENT_OFFICE}',
            message: 'Report'
        }]
    }));
    process.env.WA_RECIPIENT_OFFICE = '380661234567';

    const schedulerManager = {
        config: loadConfig(configPath),
        apply(config) { this.config = config; }
    };
    const app = createWebServer({
        client: {},
        stateStore: {},
        schedulerManager,
        configPath,
        status: { whatsapp: 'ready' },
        activity
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const controller = new AbortController();
    t.after(() => {
        controller.abort();
        server.close();
        delete process.env.WA_RECIPIENT_OFFICE;
    });

    const response = await fetch(`http://127.0.0.1:${port}/api/activity/stream`, {
        signal: controller.signal
    });
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const originalLog = console.log;
    console.log = () => {};

    try {
        activity.info('job.started', { jobId: 'report', message: 'Job started' });
        const first = decoder.decode((await reader.read()).value);
        assert.match(first, /"type":"job\.started"/);

        activity.clear();
        const second = decoder.decode((await reader.read()).value);
        assert.match(second, /event: clear/);
    } finally {
        console.log = originalLog;
    }
});

test('the last local job can be deleted', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-web-delete-last-job-'));
    const configPath = path.join(directory, 'schedule.json');
    fs.writeFileSync(configPath, JSON.stringify({
        timezone: 'Europe/Kyiv',
        jobs: [{
            id: 'report',
            schedule: '0 8 * * 1',
            recipient: '380661234567',
            message: 'Report'
        }]
    }));

    const schedulerManager = {
        config: loadConfig(configPath),
        apply(config) { this.config = config; }
    };
    const app = createWebServer({
        client: {},
        stateStore: {},
        schedulerManager,
        configPath,
        status: { whatsapp: 'ready' }
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => {
        server.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const { port } = server.address();

    const response = await fetch(`http://127.0.0.1:${port}/api/jobs/report`, {
        method: 'DELETE'
    });

    assert.equal(response.status, 200);
    assert.deepEqual(loadConfig(configPath, {}).jobs, []);
    assert.deepEqual(schedulerManager.config.jobs, []);
});

test('notification API masks ntfy topic and persists local notification settings', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-web-notifications-'));
    const configPath = path.join(directory, 'schedule.json');
    const envPath = path.join(directory, '.env');
    fs.writeFileSync(configPath, JSON.stringify({
        timezone: 'Europe/Kyiv',
        notifications: {
            whatsapp: { enabled: false, recipient: '${WA_RECIPIENT_SELF}', events: ['job.completed'], includeMessage: false },
            ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '${WA_NTFY_TOPIC}', events: ['job.failed'], includeMessage: false }
        },
        jobs: []
    }));
    fs.writeFileSync(envPath, 'WA_RECIPIENT_SELF=380661234567\nWA_NTFY_TOPIC=old-private-topic\n');
    process.env.WA_RECIPIENT_SELF = '380661234567';
    process.env.WA_NTFY_TOPIC = 'old-private-topic';

    const schedulerManager = { config: loadConfig(configPath), tasks: [], apply(config) { this.config = config; } };
    const applied = [];
    const notificationManager = {
        apply(config) { applied.push(config); },
        async test() {}
    };
    const app = createWebServer({
        client: {}, stateStore: {}, schedulerManager, notificationManager,
        configPath, envPath, status: { whatsapp: 'ready' }
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => {
        server.close();
        fs.rmSync(directory, { recursive: true, force: true });
        delete process.env.WA_RECIPIENT_SELF;
        delete process.env.WA_NTFY_TOPIC;
    });
    const { port } = server.address();

    const before = await fetch(`http://127.0.0.1:${port}/api/notifications`).then((response) => response.json());
    assert.equal(before.ntfy.topicConfigured, true);
    assert.doesNotMatch(JSON.stringify(before), /old-private-topic/);

    const response = await fetch(`http://127.0.0.1:${port}/api/notifications`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            whatsapp: { enabled: true, recipientKey: 'WA_RECIPIENT_SELF', events: ['job.completed', 'job.failed'], includeMessage: true },
            ntfy: { enabled: true, server: 'https://ntfy.sh', topic: 'new-secret-topic', events: ['job.failed', 'whatsapp.disconnected'], includeMessage: false }
        })
    });

    assert.equal(response.status, 200);
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(raw.notifications.whatsapp.recipient, '${WA_RECIPIENT_SELF}');
    assert.equal(raw.notifications.whatsapp.includeMessage, true);
    assert.equal(raw.notifications.ntfy.topic, '${WA_NTFY_TOPIC}');
    assert.equal(raw.notifications.ntfy.includeMessage, false);
    assert.match(fs.readFileSync(envPath, 'utf8'), /WA_NTFY_TOPIC=new-secret-topic/);
    assert.equal(applied.at(-1).ntfy.topic, 'new-secret-topic');
    assert.equal(applied.at(-1).whatsapp.includeMessage, true);
});

test('notification test API delegates to the selected provider', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-web-notification-test-'));
    const configPath = path.join(directory, 'schedule.json');
    fs.writeFileSync(configPath, JSON.stringify({ timezone: 'Europe/Kyiv', jobs: [] }));
    const calls = [];
    const schedulerManager = { config: loadConfig(configPath), tasks: [], apply(config) { this.config = config; } };
    const app = createWebServer({
        client: {}, stateStore: {}, schedulerManager,
        notificationManager: { apply() {}, async test(provider) { calls.push(provider); return { accepted: true, id: 'test-id' }; } },
        configPath, status: { whatsapp: 'ready' }
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => {
        server.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const { port } = server.address();

    const response = await fetch(`http://127.0.0.1:${port}/api/notifications/test/ntfy`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ['ntfy']);
    const body = await response.json();
    assert.equal(body.provider, 'ntfy');
    assert.equal(body.accepted, true);
    assert.match(body.message, /Published to ntfy/);
});

test('manual job sends notify the configured operator after delivery', async (t) => {
    const { StateStore } = require('../src/state');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-web-manual-notification-'));
    const configPath = path.join(directory, 'schedule.json');
    fs.writeFileSync(configPath, JSON.stringify({
        timezone: 'Europe/Kyiv',
        notifications: {
            version: 2,
            whatsapp: { enabled: true, recipient: '${WA_RECIPIENT_SELF}', events: ['job.manual.completed'] },
            ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '${WA_NTFY_TOPIC}', events: [] }
        },
        jobs: [{ id: 'report', schedule: '0 8 * * 1', recipient: '${WA_RECIPIENT_OFFICE}', message: 'Report' }]
    }));
    process.env.WA_RECIPIENT_SELF = '380660000000';
    process.env.WA_RECIPIENT_OFFICE = '380661234567';

    const notifications = [];
    const notificationManager = {
        apply() {},
        async notify(type, context) { notifications.push({ type, jobId: context.job.id, sentItems: context.sentItems }); }
    };
    const schedulerManager = { config: loadConfig(configPath), tasks: [], apply(config) { this.config = config; } };
    const stateStore = new StateStore(path.join(directory, 'state.json'));
    const client = { async sendMessage() { return {}; } };
    const app = createWebServer({
        client, stateStore, schedulerManager, notificationManager,
        configPath, status: { whatsapp: 'ready' }
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => {
        server.close();
        fs.rmSync(directory, { recursive: true, force: true });
        delete process.env.WA_RECIPIENT_SELF;
        delete process.env.WA_RECIPIENT_OFFICE;
    });
    const { port } = server.address();

    const response = await fetch(`http://127.0.0.1:${port}/api/jobs/report/send`, { method: 'POST' });

    assert.equal(response.status, 200);
    assert.deepEqual(notifications, [{ type: 'job.manual.completed', jobId: 'report', sentItems: 1 }]);
});

test('ntfy test API returns publication diagnostics', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-web-ntfy-diagnostics-'));
    const configPath = path.join(directory, 'schedule.json');
    fs.writeFileSync(configPath, JSON.stringify({ timezone: 'Europe/Kyiv', jobs: [] }));
    const schedulerManager = { config: loadConfig(configPath), tasks: [], apply(config) { this.config = config; } };
    const app = createWebServer({
        client: {}, stateStore: {}, schedulerManager,
        notificationManager: {
            apply() {},
            async test() {
                return { accepted: true, id: 'ntfy-message-id', testId: 'abc12345', publishedAt: '2026-07-08T05:00:00.000Z' };
            }
        },
        configPath, status: { whatsapp: 'ready' }
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => {
        server.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const { port } = server.address();

    const response = await fetch(`http://127.0.0.1:${port}/api/notifications/test/ntfy`, { method: 'POST' });
    const body = await response.json();

    assert.equal(body.messageId, 'ntfy-message-id');
    assert.equal(body.testId, 'abc12345');
    assert.equal(body.publishedAt, '2026-07-08T05:00:00.000Z');
    assert.match(body.message, /Message ID: ntfy-message-id/);
});

test('ntfy topic can be sent to a selected WhatsApp recipient without exposing it in activity', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-web-ntfy-topic-share-'));
    const configPath = path.join(directory, 'schedule.json');
    const envPath = path.join(directory, '.env');
    const activity = new ActivityLog(path.join(directory, 'activity.jsonl'));
    fs.writeFileSync(configPath, JSON.stringify({
        timezone: 'Europe/Kyiv',
        notifications: {
            whatsapp: { enabled: false, recipient: '', events: [] },
            ntfy: { enabled: true, server: 'https://ntfy.sh', topic: '${WA_NTFY_TOPIC}', events: [] }
        },
        jobs: []
    }));
    fs.writeFileSync(envPath, 'WA_RECIPIENT_SELF=380661234567\nWA_NTFY_TOPIC=private-topic-123\n');
    process.env.WA_RECIPIENT_SELF = '380661234567';
    process.env.WA_NTFY_TOPIC = 'private-topic-123';

    const sent = [];
    const client = {
        async sendMessage(chatId, message) {
            sent.push({ chatId, message });
            return {};
        }
    };
    const schedulerManager = { config: loadConfig(configPath), tasks: [], apply(config) { this.config = config; } };
    const app = createWebServer({
        client,
        stateStore: {},
        schedulerManager,
        configPath,
        envPath,
        status: { whatsapp: 'ready' },
        activity
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => {
        server.close();
        fs.rmSync(directory, { recursive: true, force: true });
        delete process.env.WA_RECIPIENT_SELF;
        delete process.env.WA_NTFY_TOPIC;
    });
    const { port } = server.address();

    const response = await fetch(`http://127.0.0.1:${port}/api/notifications/ntfy/topic/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipientKey: 'WA_RECIPIENT_SELF' })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.recipient, 'SELF');
    assert.deepEqual(sent, [{
        chatId: '380661234567@c.us',
        message: [
            '🔔 ntfy topic for wa-scheduler',
            '',
            'Server: https://ntfy.sh',
            'Topic: private-topic-123',
            '',
            'Copy the topic and subscribe to it in the ntfy app.'
        ].join('\n')
    }]);
    const activityEvents = activity.list({ limit: 10 });
    assert.equal(activityEvents[0].type, 'notification.ntfy_topic.sent');
    assert.match(activityEvents[0].message, /SELF/);
    assert.doesNotMatch(JSON.stringify(activityEvents), /private-topic-123|380661234567/);
});
