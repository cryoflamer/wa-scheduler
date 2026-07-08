const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { sendDocument } = require('../src/whatsapp');

test('document sends preserve Unicode filename and include filesize metadata', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-document-'));
    const filePath = path.join(directory, 'Звіт за понеділок.txt');
    const contents = 'document body';
    fs.writeFileSync(filePath, contents);

    let sentMedia;
    let sentOptions;
    const client = {
        async sendMessage(_chatId, media, options) {
            sentMedia = media;
            sentOptions = options;
        }
    };

    await sendDocument(client, '380661234567', {
        path: filePath,
        caption: 'Звіт'
    });

    assert.equal(sentMedia.filename, 'Звіт за понеділок.txt');
    assert.equal(sentMedia.filesize, Buffer.byteLength(contents));
    assert.equal(sentOptions.sendMediaAsDocument, true);
    assert.equal(sentOptions.caption, 'Звіт');
});
