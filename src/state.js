const fs = require('fs');
const path = require('path');

class StateStore {
    constructor(statePath = 'data/state.json') {
        this.statePath = path.resolve(statePath);
        this.state = this.load();
    }

    load() {
        if (!fs.existsSync(this.statePath)) return {};
        const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(`Invalid scheduler state: ${this.statePath}`);
        }
        return parsed;
    }

    has(key) { return Object.prototype.hasOwnProperty.call(this.state, key); }
    isComplete(key) { return this.state[key]?.status === 'sent'; }
    isMessageSent(key) { return this.state[key]?.message?.status === 'sent'; }
    isFileSent(key, filePath) { return this.state[key]?.files?.[filePath]?.status === 'sent'; }
    isNotificationSent(key, eventType, provider) {
        return this.state[key]?.notifications?.[eventType]?.[provider]?.status === 'sent';
    }

    markRunStarted(key, startedAt) {
        const record = this.ensureJobRecord(key);
        record.status = record.status === 'sent' ? 'sent' : 'running';
        record.startedAt ||= startedAt;
        delete record.failedAt;
        this.persist();
    }

    markRunFailed(key, failedAt) {
        const record = this.ensureJobRecord(key);
        if (record.status !== 'sent') record.status = 'failed';
        record.failedAt = failedAt;
        this.persist();
    }

    markRetryScheduled(key, retryAttempt, nextRetryAt) {
        const record = this.ensureJobRecord(key);
        if (record.status !== 'sent') record.status = 'retrying';
        record.retry = { attempt: retryAttempt, nextRetryAt };
        this.persist();
    }

    clearRetry(key) {
        const record = this.state[key];
        if (!record || typeof record !== 'object') return;
        delete record.retry;
        this.persist();
    }

    listPendingRetries() {
        return Object.entries(this.state).flatMap(([key, record]) => {
            if (record?.status !== 'retrying' || !record.retry?.nextRetryAt) return [];
            const separator = key.lastIndexOf(':');
            if (separator <= 0) return [];
            return [{
                key,
                jobId: key.slice(0, separator),
                retryAttempt: Number(record.retry.attempt),
                nextRetryAt: record.retry.nextRetryAt
            }];
        }).filter((entry) => Number.isInteger(entry.retryAttempt) && entry.retryAttempt > 0);
    }

    markMessageSent(key, sentAt) {
        const record = this.ensureJobRecord(key);
        record.message = { status: 'sent', sentAt };
        this.persist();
    }

    markFileSent(key, filePath, sentAt) {
        const record = this.ensureJobRecord(key);
        record.files[filePath] = { status: 'sent', sentAt };
        this.persist();
    }

    markNotificationSent(key, eventType, provider, sentAt) {
        const record = this.ensureJobRecord(key);
        if (!record.notifications || typeof record.notifications !== 'object') record.notifications = {};
        if (!record.notifications[eventType] || typeof record.notifications[eventType] !== 'object') {
            record.notifications[eventType] = {};
        }
        record.notifications[eventType][provider] = { status: 'sent', sentAt };
        this.persist();
    }

    getRunDetails(key, job) {
        const record = this.state[key] || {};
        const items = [];

        if (job.message) {
            items.push({
                type: 'message',
                label: 'message',
                sent: record.message?.status === 'sent'
            });
        }

        for (const file of job.files) {
            items.push({
                type: 'file',
                label: path.basename(file.path),
                sent: record.files?.[file.path]?.status === 'sent'
            });
        }

        const sent = items.filter((item) => item.sent);
        const pending = items.filter((item) => !item.sent);
        return {
            sentItems: sent.length,
            totalItems: items.length,
            sent,
            pending
        };
    }

    getRunProgress(key, job) {
        const { sentItems, totalItems } = this.getRunDetails(key, job);
        return { sentItems, totalItems };
    }

    markComplete(key, sentAt) {
        const record = this.ensureJobRecord(key);
        record.status = 'sent';
        record.sentAt = sentAt;
        delete record.failedAt;
        delete record.retry;
        this.persist();
    }

    markSent(key, sentAt) {
        this.state[key] = { status: 'sent', sentAt };
        this.persist();
    }

    getLatestScheduledRun(job) {
        const prefix = `${job.id}:`;
        const entries = Object.entries(this.state)
            .filter(([key]) => key.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}$/.test(key.slice(prefix.length)))
            .sort(([left], [right]) => right.localeCompare(left));
        if (entries.length === 0) return null;

        const [key, record] = entries[0];
        const { sentItems, totalItems } = this.getRunProgress(key, job);
        let status = record.status || 'pending';
        if (status === 'failed' && sentItems > 0 && sentItems < totalItems) status = 'partial';

        return {
            key,
            date: key.slice(prefix.length),
            status,
            sentItems,
            totalItems,
            timestamp: record.sentAt || record.failedAt || record.startedAt || null,
            retry: record.retry || null
        };
    }

    ensureJobRecord(key) {
        const current = this.state[key];
        if (!current || typeof current !== 'object' || Array.isArray(current)) this.state[key] = {};
        if (!this.state[key].files || typeof this.state[key].files !== 'object') this.state[key].files = {};
        return this.state[key];
    }

    persist() {
        const directory = path.dirname(this.statePath);
        const temporaryPath = `${this.statePath}.tmp`;
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`);
        fs.renameSync(temporaryPath, this.statePath);
    }
}

module.exports = { StateStore };
