const { sendTextMessage } = require('../whatsapp');

async function sendWhatsAppNotification(client, config, notification) {
    await sendTextMessage(client, config.recipient, notification.message);
}

module.exports = { sendWhatsAppNotification };
