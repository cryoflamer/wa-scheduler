function topicUrl(server, topic) {
    const url = new URL(server);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error('ntfy server must use http or https');
    }
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodeURIComponent(topic)}`;
    return url.toString();
}

async function sendNtfyNotification(_client, config, notification, fetchImpl = fetch) {
    const response = await fetchImpl(topicUrl(config.server, config.topic), {
        method: 'POST',
        headers: {
            Title: notification.title,
            Priority: notification.priority,
            Tags: notification.tags.join(',')
        },
        body: notification.message
    });

    if (!response.ok) {
        throw new Error(`ntfy request failed: HTTP ${response.status}`);
    }
}

module.exports = { sendNtfyNotification, topicUrl };
