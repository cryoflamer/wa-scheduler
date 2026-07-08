const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { NotificationManager, buildNotification } = require('../src/notifications/manager');
const { sendNtfyNotification, topicUrl } = require('../src/notifications/ntfy');
const { StateStore } = require('../src/state');

function withManager(callback) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-notifications-'));
    const stateStore = new StateStore(path.join(directory, 'state.json'));
    const calls = [];
    const manager = new NotificationManager({
        client: {},
        stateStore,
        providers: {
            whatsapp: async (_client, config, notification) => calls.push(['whatsapp', config.recipient, notification.message]),
            ntfy: async (_client, config, notification) => calls.push(['ntfy', config.topic, notification.priority])
        }
    });
    manager.apply({
        whatsapp: { enabled: true, recipient: '380660000000', events: ['job.completed', 'job.failed', 'job.partial'] },
        ntfy: { enabled: true, server: 'https://ntfy.sh', topic: 'private-topic', events: ['job.completed', 'job.failed', 'job.partial', 'whatsapp.disconnected'] }
    });

    return Promise.resolve(callback({ manager, stateStore, calls }))
        .finally(() => fs.rmSync(directory, { recursive: true, force: true }));
}

test('completed job notifications are sent once per provider and run key', async () => {
    await withManager(async ({ manager, stateStore, calls }) => {
        const context = {
            job: { id: 'report', message: 'Report', files: [{ path: 'documents/report.pdf', caption: '' }] },
            sentItems: 2,
            idempotencyKey: 'report:2026-07-08'
        };

        await manager.notify('job.completed', context);
        await manager.notify('job.completed', context);

        assert.equal(calls.length, 2);
        assert.deepEqual(calls.map((call) => call[0]), ['whatsapp', 'ntfy']);
        assert.equal(stateStore.isNotificationSent(context.idempotencyKey, 'job.completed', 'whatsapp'), true);
        assert.equal(stateStore.isNotificationSent(context.idempotencyKey, 'job.completed', 'ntfy'), true);
    });
});

test('failed providers remain retryable without duplicating successful providers', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-notification-retry-'));
    const stateStore = new StateStore(path.join(directory, 'state.json'));
    let whatsappCalls = 0;
    let ntfyCalls = 0;
    const manager = new NotificationManager({
        client: {}, stateStore,
        providers: {
            whatsapp: async () => { whatsappCalls += 1; },
            ntfy: async () => { ntfyCalls += 1; if (ntfyCalls === 1) throw new Error('offline'); }
        }
    });
    manager.apply({
        whatsapp: { enabled: true, recipient: '380660000000', events: ['job.failed'] },
        ntfy: { enabled: true, server: 'https://ntfy.sh', topic: 'topic', events: ['job.failed'] }
    });
    const context = {
        job: { id: 'report', message: 'Report', files: [] },
        error: new Error('send failed'),
        idempotencyKey: 'report:2026-07-08'
    };

    try {
        await manager.notify('job.failed', context);
        await manager.notify('job.failed', context);
        assert.equal(whatsappCalls, 1);
        assert.equal(ntfyCalls, 2);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('operator notifications include recipient and item details but omit message body by default', () => {
    const job = {
        id: 'report',
        recipient: '380661234567',
        message: 'PRIVATE BODY',
        files: [
            { path: 'documents/report.pdf', caption: 'PRIVATE CAPTION' },
            { path: 'documents/table.xlsx', caption: '' }
        ]
    };
    const notification = buildNotification('job.partial', {
        job,
        error: new Error('temporary failure'),
        progress: {
            sentItems: 2,
            totalItems: 3,
            sent: [{ type: 'message', label: 'message', sent: true }, { type: 'file', label: 'report.pdf', sent: true }],
            pending: [{ type: 'file', label: 'table.xlsx', sent: false }]
        }
    }, {
        environment: { WA_RECIPIENT_LYOSHA: '380661234567' }
    });

    assert.match(notification.message, /To: LYOSHA/);
    assert.equal(notification.message.includes('Sent:\n• message\n• report.pdf'), true);
    assert.equal(notification.message.includes('Pending:\n• table.xlsx'), true);
    assert.equal(notification.message.includes('Error:\ntemporary failure'), true);
    assert.doesNotMatch(notification.message, /PRIVATE BODY|PRIVATE CAPTION|380661234567/);
});

test('message body is included in operator notifications only when enabled', () => {
    const context = {
        job: {
            id: 'report',
            recipient: '380661234567',
            message: 'Full report message',
            files: []
        },
        sentItems: 1
    };

    const hidden = buildNotification('job.completed', context, {
        environment: { WA_RECIPIENT_OFFICE: '380661234567' },
        includeMessage: false
    });
    const visible = buildNotification('job.completed', context, {
        environment: { WA_RECIPIENT_OFFICE: '380661234567' },
        includeMessage: true
    });

    assert.doesNotMatch(hidden.message, /Full report message/);
    assert.equal(visible.message.includes('Message:\nFull report message'), true);
});

test('notification tests return provider acknowledgement metadata', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-notification-ack-'));
    const stateStore = new StateStore(path.join(directory, 'state.json'));
    const manager = new NotificationManager({
        client: {}, stateStore,
        providers: {
            whatsapp: async () => ({ accepted: true, id: 'wa-test' }),
            ntfy: async () => ({ accepted: true, id: 'ntfy-test' })
        }
    });
    manager.apply({
        whatsapp: { enabled: false, recipient: '', events: [] },
        ntfy: { enabled: true, server: 'https://ntfy.sh', topic: 'topic', events: [] }
    });

    try {
        const result = await manager.test('ntfy');
        assert.equal(result.accepted, true);
        assert.equal(result.id, 'ntfy-test');
        assert.match(result.testId, /^[0-9a-f-]{8}$/);
        assert.ok(Date.parse(result.publishedAt));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('providers can independently include the scheduled message body', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-notification-message-option-'));
    const stateStore = new StateStore(path.join(directory, 'state.json'));
    const bodies = {};
    const manager = new NotificationManager({
        client: {},
        stateStore,
        environment: { WA_RECIPIENT_LYOSHA: '380661234567' },
        providers: {
            whatsapp: async (_client, _config, notification) => { bodies.whatsapp = notification.message; },
            ntfy: async (_client, _config, notification) => { bodies.ntfy = notification.message; }
        }
    });
    manager.apply({
        whatsapp: { enabled: true, recipient: '380660000000', events: ['job.completed'], includeMessage: false },
        ntfy: { enabled: true, server: 'https://ntfy.sh', topic: 'topic', events: ['job.completed'], includeMessage: true }
    });

    try {
        await manager.notify('job.completed', {
            job: { id: 'report', recipient: '380661234567', message: 'Private body', files: [] },
            sentItems: 1,
            idempotencyKey: 'report:2026-07-08'
        });

        assert.doesNotMatch(bodies.whatsapp, /Private body/);
        assert.equal(bodies.ntfy.includes('Message:\nPrivate body'), true);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('ntfy provider posts to the configured topic with priority headers', async () => {
    let request;
    await sendNtfyNotification({}, { server: 'https://ntfy.sh', topic: 'topic name' }, {
        title: 'wa-scheduler failed', priority: 'high', tags: ['x'], message: 'failed'
    }, async (url, options) => {
        request = { url, options };
        return { ok: true, json: async () => ({ id: 'message-id', event: 'message' }) };
    });

    assert.equal(request.url, 'https://ntfy.sh/topic%20name');
    assert.equal(request.options.headers.Priority, 'high');
    assert.equal(request.options.body, 'failed');
    assert.equal(topicUrl('https://example.com/base/', 'topic'), 'https://example.com/base/topic');
});

test('manual notification text distinguishes dashboard sends from scheduled runs', () => {
    const job = { id: 'report', message: 'Report', files: [{ path: 'documents/report.pdf', caption: '' }] };

    const completed = buildNotification('job.manual.completed', { job, sentItems: 2 });
    const partial = buildNotification('job.manual.partial', { job, sentItems: 1 });
    const failed = buildNotification('job.manual.failed', { job, error: new Error('offline') });

    assert.match(completed.message, /sent manually/);
    assert.match(partial.message, /manual send partially completed/);
    assert.match(failed.message, /manual send failed/);
});

test('notification tests are unique and expose ntfy acknowledgement ids in activity', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-notification-test-diagnostics-'));
    const stateStore = new StateStore(path.join(directory, 'state.json'));
    const activityEvents = [];
    const notifications = [];
    const manager = new NotificationManager({
        client: {},
        stateStore,
        activity: {
            sent(type, fields) { activityEvents.push({ type, ...fields }); }
        },
        providers: {
            whatsapp: async () => ({ accepted: true }),
            ntfy: async (_client, _config, notification) => {
                notifications.push(notification.message);
                return { accepted: true, id: `ntfy-${notifications.length}` };
            }
        }
    });
    manager.apply({
        whatsapp: { enabled: false, recipient: '', events: [] },
        ntfy: { enabled: true, server: 'https://ntfy.sh', topic: 'topic', events: [] }
    });

    try {
        const first = await manager.test('ntfy');
        const second = await manager.test('ntfy');

        assert.notEqual(first.testId, second.testId);
        assert.notEqual(notifications[0], notifications[1]);
        assert.equal(first.id, 'ntfy-1');
        assert.equal(activityEvents[0].details.messageId, 'ntfy-1');
        assert.match(activityEvents[0].message, /ntfy-1/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
