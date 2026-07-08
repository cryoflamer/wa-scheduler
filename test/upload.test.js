const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
    sanitizeUploadFilename,
    uniqueUploadFilename
} = require('../src/web/server');

test('Unicode upload filenames are preserved', () => {
    assert.equal(
        sanitizeUploadFilename('Звіт за понеділок.pdf'),
        'Звіт за понеділок.pdf'
    );
});

test('UTF-8 multipart filenames decoded as latin1 are repaired', () => {
    const original = 'Звіт за понеділок.pdf';
    const mojibake = Buffer.from(original, 'utf8').toString('latin1');

    assert.equal(sanitizeUploadFilename(mojibake), original);
});

test('duplicate Unicode filenames receive a numeric suffix', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-upload-'));
    fs.writeFileSync(path.join(directory, 'Звіт за понеділок.pdf'), 'one');

    assert.equal(
        uniqueUploadFilename(directory, 'Звіт за понеділок.pdf'),
        'Звіт за понеділок-2.pdf'
    );
});
