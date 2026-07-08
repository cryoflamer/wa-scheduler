const assert = require('node:assert/strict');
const test = require('node:test');
const { recipientKey, serializeJob } = require('../src/web/server');

test('UI job serialization exposes recipient aliases without phone numbers', () => {
    const serialized = serializeJob({
        id: 'report',
        schedule: '0 8 * * 1',
        recipient: '${WA_RECIPIENT_OFFICE}',
        message: 'Report',
        files: ['documents/report.pdf']
    });

    assert.equal(serialized.recipientKey, 'WA_RECIPIENT_OFFICE');
    assert.deepEqual(serialized.files, [{ path: 'documents/report.pdf', caption: '' }]);
});

test('recipient key is empty for non-placeholder schedule values', () => {
    assert.equal(recipientKey('380661234567'), '');
});

test('UI job serialization exposes operational status', () => {
    const schedulerManager = { getNextRun: () => new Date('2026-07-13T05:00:00.000Z') };
    const stateStore = { getLatestScheduledRun: () => ({ status: 'sent', timestamp: '2026-07-06T05:00:00.000Z' }) };
    const serialized = serializeJob({
        id: 'report', enabled: false, schedule: '0 8 * * 1', recipient: '${WA_RECIPIENT_OFFICE}', message: 'Report', files: []
    }, { schedulerManager, stateStore, normalizedJob: { id: 'report', message: 'Report', files: [] } });

    assert.equal(serialized.enabled, false);
    assert.equal(serialized.nextRun, '2026-07-13T05:00:00.000Z');
    assert.equal(serialized.lastRun.status, 'sent');
});

test('notification serialization exposes aliases and masks ntfy secrets', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { serializeNotifications } = require('../src/web/server');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-notification-ui-'));
    const envPath = path.join(directory, '.env');
    fs.writeFileSync(envPath, 'WA_NTFY_TOPIC=private-topic-value\n');

    try {
        const serialized = serializeNotifications({
            notifications: {
                whatsapp: { enabled: true, recipient: '${WA_RECIPIENT_SELF}', events: ['job.completed'] },
                ntfy: { enabled: true, server: 'https://ntfy.sh', topic: '${WA_NTFY_TOPIC}', events: ['job.failed'] }
            }
        }, envPath);
        assert.equal(serialized.whatsapp.recipientKey, 'WA_RECIPIENT_SELF');
        assert.equal(serialized.ntfy.topicConfigured, true);
        assert.equal(serialized.whatsapp.includeMessage, false);
        assert.equal(serialized.ntfy.includeMessage, false);
        assert.doesNotMatch(JSON.stringify(serialized), /private-topic-value/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('UI job serialization includes retry policy', () => {
    const { serializeJob, jobFromBody } = require('../src/web/server');
    const serialized = serializeJob({
        id: 'report', schedule: '0 8 * * *', recipient: '${WA_RECIPIENT_SELF}',
        retry: { attempts: 5, delayMinutes: 10 }, message: 'Report', files: []
    });
    assert.deepEqual(serialized.retry, { attempts: 5, delayMinutes: 10 });

    const raw = jobFromBody({
        id: 'report', schedule: '0 8 * * *', recipientKey: 'WA_RECIPIENT_SELF',
        retryEnabled: true, retryAttempts: 4, retryDelayMinutes: 15,
        message: 'Report', files: []
    });
    assert.deepEqual(raw.retry, { attempts: 4, delayMinutes: 15 });
});
