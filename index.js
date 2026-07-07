const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const client = new Client({
    authStrategy: new LocalAuth()
});

function normalizeNumber(number) {
    return number.replace(/[^\d]/g, '');
}

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

client.on('ready', async () => {
    console.log('WhatsApp ready');

    const testNumber = process.env.WA_TEST_NUMBER;
    const testFile = process.env.WA_TEST_FILE;

    if (!testNumber) {
        console.log('WA_TEST_NUMBER is not set; skipping test send');
        return;
    }

    const chatId = `${normalizeNumber(testNumber)}@c.us`;

    try {
        if (testFile) {
            const filePath = path.resolve(testFile);

            if (!fs.existsSync(filePath)) {
                console.error(`File does not exist: ${filePath}`);
                return;
            }

            const media = MessageMedia.fromFilePath(filePath);

            await client.sendMessage(chatId, media, {
                sendMediaAsDocument: true,
                caption: process.env.WA_TEST_CAPTION || ''
            });

            console.log(`Test document sent to ${testNumber}: ${filePath}`);
            return;
        }

        await client.sendMessage(
            chatId,
            'wa-scheduler test message'
        );

        console.log(`Test message sent to ${testNumber}`);
    } catch (error) {
        console.error('Failed to send test message:', error);
    }
});

client.on('disconnected', (reason) => {
    console.log('WhatsApp disconnected:', reason);
});

client.initialize();
