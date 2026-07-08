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
