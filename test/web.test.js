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
