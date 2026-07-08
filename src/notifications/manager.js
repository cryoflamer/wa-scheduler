const crypto = require('crypto');
const path = require('path');
const { safeErrorMessage } = require('../activity');
const { maskNumber } = require('../recipients');
const { sendWhatsAppNotification } = require('./whatsapp');
const { sendNtfyNotification } = require('./ntfy');

function itemCount(job) {
    return (job.message ? 1 : 0) + job.files.length;
}

function recipientLabel(job, environment = process.env) {
    if (!job?.recipient) return 'unknown';
    const match = Object.entries(environment).find(([key, value]) => (
        key.startsWith('WA_RECIPIENT_') && value === job.recipient
    ));
    return match ? match[0].slice('WA_RECIPIENT_'.length) : maskNumber(job.recipient);
}

function normalizeProgress(job, context = {}) {
    const fallbackItems = [
        ...(job?.message ? [{ type: 'message', label: 'message', sent: true }] : []),
        ...(job?.files || []).map((file) => ({ type: 'file', label: path.basename(file.path), sent: true }))
    ];
    const progress = context.progress || null;
    if (progress) return progress;

    const totalItems = job ? itemCount(job) : 0;
    const sentCount = context.sentItems ?? totalItems;
    return {
        sentItems: sentCount,
        totalItems,
        sent: fallbackItems.slice(0, sentCount),
        pending: fallbackItems.slice(sentCount).map((item) => ({ ...item, sent: false }))
    };
}

function formatItems(title, items) {
    if (!items?.length) return '';
    return `${title}:\n${items.map((item) => `• ${item.label}`).join('\n')}`;
}

function detailSections(job, context, options = {}) {
    const progress = normalizeProgress(job, context);
    const sections = [`To: ${recipientLabel(job, options.environment)}`];

    if (options.includeMessage && job?.message) {
        sections.push(`Message:\n${job.message}`);
    }

    const sent = formatItems('Sent', progress.sent);
    const pending = formatItems('Pending', progress.pending);
    if (sent) sections.push(sent);
    if (pending) sections.push(pending);
    if (!progress.sent?.length && progress.totalItems > 0) sections.push('Nothing was sent.');

    return { progress, sections };
}

function buildNotification(type, context = {}, options = {}) {
    const job = context.job;
    const { progress, sections } = job
        ? detailSections(job, context, options)
        : { progress: { sentItems: 0, totalItems: 0 }, sections: [] };
    const sentItems = progress.sentItems;
    const totalItems = progress.totalItems;
    const details = sections.join('\n\n');

    if (type === 'job.completed') {
        return {
            title: 'wa-scheduler',
            priority: 'default',
            tags: ['white_check_mark'],
            message: `✅ ${job.id} completed\n\n${details}\n\n${sentItems} item${sentItems === 1 ? '' : 's'} sent successfully.`
        };
    }
    if (type === 'job.partial') {
        return {
            title: 'wa-scheduler warning',
            priority: 'high',
            tags: ['warning'],
            message: `⚠️ ${job.id} partially sent\n\n${details}\n\n${sentItems} of ${totalItems} items sent. Unsent items remain pending.${context.error ? `\n\nError:\n${safeErrorMessage(context.error)}` : ''}`
        };
    }
    if (type === 'job.failed') {
        return {
            title: 'wa-scheduler failed',
            priority: 'high',
            tags: ['x'],
            message: `❌ ${job.id} failed\n\n${details}\n\nError:\n${safeErrorMessage(context.error)}`
        };
    }
    if (type === 'job.manual.completed') {
        return {
            title: 'wa-scheduler',
            priority: 'default',
            tags: ['white_check_mark'],
            message: `✅ ${job.id} sent manually\n\n${details}\n\n${sentItems} item${sentItems === 1 ? '' : 's'} sent successfully.`
        };
    }
    if (type === 'job.manual.partial') {
        return {
            title: 'wa-scheduler warning',
            priority: 'high',
            tags: ['warning'],
            message: `⚠️ ${job.id} manual send partially completed\n\n${details}\n\n${sentItems} of ${totalItems} items sent. Unsent items remain pending.${context.error ? `\n\nError:\n${safeErrorMessage(context.error)}` : ''}`
        };
    }
    if (type === 'job.manual.failed') {
        return {
            title: 'wa-scheduler failed',
            priority: 'high',
            tags: ['x'],
            message: `❌ ${job.id} manual send failed\n\n${details}\n\nError:\n${safeErrorMessage(context.error)}`
        };
    }
    if (type === 'whatsapp.disconnected') {
        return {
            title: 'WhatsApp disconnected',
            priority: 'urgent',
            tags: ['rotating_light'],
            message: '❌ WhatsApp disconnected\n\nwa-scheduler cannot send scheduled jobs until the session is ready again.'
        };
    }
    if (type === 'notification.test') {
        return {
            title: 'wa-scheduler',
            priority: 'default',
            tags: ['white_check_mark'],
            message: `✅ wa-scheduler test notification\n\nTest ID: ${context.testId}\nPublished: ${context.publishedAt}`
        };
    }
    throw new Error(`Unsupported notification type: ${type}`);
}

class NotificationManager {
    constructor({ client, stateStore, activity = null, providers = {}, environment = process.env }) {
        this.client = client;
        this.stateStore = stateStore;
        this.activity = activity;
        this.environment = environment;
        this.providers = {
            whatsapp: providers.whatsapp || sendWhatsAppNotification,
            ntfy: providers.ntfy || sendNtfyNotification
        };
        this.config = {
            whatsapp: { enabled: false, events: [], includeMessage: false },
            ntfy: { enabled: false, events: [], includeMessage: false }
        };
        this.systemNotifications = new Set();
    }

    apply(config = {}) {
        this.config = config;
    }

    async notify(type, context = {}) {
        const results = [];

        for (const [providerName, provider] of Object.entries(this.providers)) {
            const providerConfig = this.config[providerName];
            if (!providerConfig?.enabled || !providerConfig.events.includes(type)) continue;

            const key = context.idempotencyKey || null;
            if (key && this.wasSent(key, type, providerName)) {
                results.push({ provider: providerName, status: 'skipped' });
                continue;
            }

            try {
                const notification = buildNotification(type, context, {
                    includeMessage: providerConfig.includeMessage === true,
                    environment: this.environment
                });
                await provider(this.client, providerConfig, notification);
                if (key) this.markSent(key, type, providerName);
                this.activity?.sent('notification.sent', {
                    jobId: context.job?.id,
                    message: `${providerName} notification sent`,
                    details: { provider: providerName, event: type }
                });
                results.push({ provider: providerName, status: 'sent' });
            } catch (error) {
                this.activity?.error('notification.failed', {
                    jobId: context.job?.id,
                    message: `${providerName} notification failed`,
                    details: { provider: providerName, event: type }
                });
                results.push({ provider: providerName, status: 'failed', error });
            }
        }

        return results;
    }

    async test(providerName) {
        const provider = this.providers[providerName];
        const providerConfig = this.config[providerName];
        if (!provider || !providerConfig) {
            throw new Error(`Unknown notification provider: ${providerName}`);
        }
        if (!providerConfig.enabled) {
            throw new Error(`${providerName} notifications are not enabled`);
        }
        const testId = crypto.randomUUID().slice(0, 8);
        const publishedAt = new Date().toISOString();
        const result = await provider(
            this.client,
            providerConfig,
            buildNotification('notification.test', { testId, publishedAt })
        );
        const acknowledgement = result || { accepted: true };
        this.activity?.sent('notification.test.sent', {
            message: providerName === 'ntfy' && acknowledgement.id
                ? `ntfy test published · ${acknowledgement.id}`
                : `${providerName} test notification sent`,
            details: {
                provider: providerName,
                testId,
                ...(acknowledgement.id ? { messageId: acknowledgement.id } : {})
            }
        });
        return { ...acknowledgement, testId, publishedAt };
    }

    wasSent(key, type, provider) {
        if (key.startsWith('system:')) return this.systemNotifications.has(`${key}:${type}:${provider}`);
        return this.stateStore.isNotificationSent(key, type, provider);
    }

    markSent(key, type, provider) {
        if (key.startsWith('system:')) {
            this.systemNotifications.add(`${key}:${type}:${provider}`);
            return;
        }
        this.stateStore.markNotificationSent(key, type, provider, new Date().toISOString());
    }
}

module.exports = {
    NotificationManager,
    buildNotification,
    itemCount,
    recipientLabel,
    normalizeProgress
};
