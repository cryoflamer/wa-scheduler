const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

function normalizeNumber(number) {
    return number.replace(/[^\d]/g, '');
}

function chatIdFor(recipient) {
    return `${normalizeNumber(recipient)}@c.us`;
}

function createWhatsAppClient() {
    const client = new Client({
        authStrategy: new LocalAuth()
    });

    client.on('qr', (qr) => {
        console.log('Scan this QR code with WhatsApp:');
        qrcode.generate(qr, { small: true });
    });

    client.on('authenticated', () => {
        console.log('WhatsApp authenticated');
    });

    client.on('auth_failure', (message) => {
        console.error('WhatsApp authentication failed:', message);
    });

    client.on('disconnected', (reason) => {
        console.log('WhatsApp disconnected:', reason);
    });

    return client;
}

async function sendTextMessage(client, recipient, message) {
    await client.sendMessage(chatIdFor(recipient), message);
}

async function sendDocument(client, recipientOrJob, file) {
    const recipient = file ? recipientOrJob : recipientOrJob.recipient;
    const document = file || {
        path: recipientOrJob.file,
        caption: recipientOrJob.caption || ''
    };
    const filePath = path.resolve(document.path);

    if (!fs.existsSync(filePath)) {
        throw new Error(`Document does not exist: ${filePath}`);
    }

    const media = MessageMedia.fromFilePath(filePath);
    media.filename = path.basename(filePath);
    media.filesize = fs.statSync(filePath).size;

    const sentMessage = await client.sendMessage(chatIdFor(recipient), media, {
        sendMediaAsDocument: true,
        caption: document.caption,
        extra: {
            filename: media.filename
        }
    });

    const sentFilename = sentMessage?._data?.filename;
    if (sentFilename !== media.filename) {
        console.warn(
            `WhatsApp document filename mismatch: requested=${media.filename}; returned=${sentFilename || '<missing>'}`
        );
    }

    return filePath;
}

module.exports = {
    createWhatsAppClient,
    normalizeNumber,
    sendDocument,
    sendTextMessage
};
