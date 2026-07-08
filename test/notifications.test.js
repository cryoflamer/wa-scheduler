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

test('notification text does not include job message bodies or captions', () => {
    const notification = buildNotification('job.completed', {
        job: {
            id: 'report',
            message: 'PRIVATE BODY',
            files: [{ path: 'documents/report.pdf', caption: 'PRIVATE CAPTION' }]
        },
        sentItems: 2
    });

    assert.doesNotMatch(notification.message, /PRIVATE BODY|PRIVATE CAPTION/);
    assert.match(notification.message, /report completed/);
});

test('ntfy provider posts to the configured topic with priority headers', async () => {
    let request;
    await sendNtfyNotification({}, { server: 'https://ntfy.sh', topic: 'topic name' }, {
        title: 'wa-scheduler failed', priority: 'high', tags: ['x'], message: 'failed'
    }, async (url, options) => {
        request = { url, options };
        return { ok: true };
    });

    assert.equal(request.url, 'https://ntfy.sh/topic%20name');
    assert.equal(request.options.headers.Priority, 'high');
    assert.equal(request.options.body, 'failed');
    assert.equal(topicUrl('https://example.com/base/', 'topic'), 'https://example.com/base/topic');
});
