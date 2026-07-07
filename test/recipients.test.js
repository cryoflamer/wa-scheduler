const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
    deleteRecipient,
    loadRecipients,
    maskNumber,
    saveRecipient
} = require('../src/recipients');

function temporaryEnv() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-recipients-'));
    return path.join(directory, '.env');
}

test('recipient values are stored locally and loaded by key', () => {
    const envPath = temporaryEnv();
    fs.writeFileSync(envPath, 'OTHER_VALUE=kept\n');

    const recipient = saveRecipient('Field Office', '+380 66 123 45 67', envPath);

    assert.equal(recipient.key, 'WA_RECIPIENT_FIELD_OFFICE');
    assert.deepEqual(loadRecipients(envPath), [{
        key: 'WA_RECIPIENT_FIELD_OFFICE',
        name: 'FIELD_OFFICE',
        number: '380661234567'
    }]);
    assert.match(fs.readFileSync(envPath, 'utf8'), /^OTHER_VALUE=kept/m);

    delete process.env.WA_RECIPIENT_FIELD_OFFICE;
});

test('recipient updates replace the existing assignment', () => {
    const envPath = temporaryEnv();

    saveRecipient('SELF', '380661111111', envPath);
    saveRecipient('SELF', '380662222222', envPath);

    assert.equal(loadRecipients(envPath).length, 1);
    assert.equal(loadRecipients(envPath)[0].number, '380662222222');

    deleteRecipient('WA_RECIPIENT_SELF', envPath);
    assert.deepEqual(loadRecipients(envPath), []);
    delete process.env.WA_RECIPIENT_SELF;
});

test('phone numbers are masked for the UI', () => {
    assert.equal(maskNumber('380661234567'), '380******567');
});
