const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

function normalizeNumber(number) {
    return number.replace(/[^\d]/g, '');
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

async function sendDocument(client, job) {
    const filePath = path.resolve(job.file);

    if (!fs.existsSync(filePath)) {
        throw new Error(`Document does not exist: ${filePath}`);
    }

    const chatId = `${normalizeNumber(job.recipient)}@c.us`;
    const media = MessageMedia.fromFilePath(filePath);

    await client.sendMessage(chatId, media, {
        sendMediaAsDocument: true,
        caption: job.caption
    });

    return filePath;
}

module.exports = {
    createWhatsAppClient,
    normalizeNumber,
    sendDocument
};
