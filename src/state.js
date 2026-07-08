const fs = require('fs');
const path = require('path');
const { createJobSnapshot, fingerprintJobSnapshot } = require('./run_identity');

const DEFAULT_STATE_RETENTION_DAYS = 90;
const MAX_STATE_RETENTION_DAYS = 3650;

function parseStateRetentionDays(value) {
    if (value === undefined || value === null || value === '') return DEFAULT_STATE_RETENTION_DAYS;
    const days = Number(value);
    if (!Number.isInteger(days) || days < 1 || days > MAX_STATE_RETENTION_DAYS) {
        throw new Error(`WA_STATE_RETENTION_DAYS must be an integer between 1 and ${MAX_STATE_RETENTION_DAYS}`);
    }
    return days;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

class StateStore {
    constructor(statePath = 'data/state.json', options = {}) {
        this.statePath = path.resolve(statePath || 'data/state.json');
        this.now = options.now || (() => new Date());
        this.retentionDays = parseStateRetentionDays(
            options.retentionDays ?? process.env.WA_STATE_RETENTION_DAYS
        );
        this.state = this.load();
        if (this.pruneExpired()) this.persist();
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

    migrateLegacyScheduledRun(key, jobId) {
        if (this.has(key)) return false;
        const prefix = `${jobId}:`;
        if (!key.startsWith(prefix)) return false;
        const occurrence = key.slice(prefix.length);
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(occurrence)) return false;

        const legacyKey = `${jobId}:${occurrence.slice(0, 10)}`;
        if (!this.has(legacyKey)) return false;

        this.state[key] = this.state[legacyKey];
        delete this.state[legacyKey];
        const record = this.ensureJobRecord(key);
        record.jobId ||= jobId;
        this.persist();
        return true;
    }

    captureRunSnapshot(key, job) {
        const record = this.ensureJobRecord(key);
        if (!record.snapshot || typeof record.snapshot !== 'object' || Array.isArray(record.snapshot)) {
            record.snapshot = createJobSnapshot(job);
            record.fingerprint = fingerprintJobSnapshot(record.snapshot);
            record.jobId = record.snapshot.id;
            this.persist();
        }
        return clone(record.snapshot);
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

    cancelPendingRetriesForJob(jobId, cancelledAt, reason = 'job deleted') {
        let changed = false;
        for (const [key, record] of Object.entries(this.state)) {
            if (key.startsWith('manual:')) continue;
            const recordJobId = record?.jobId || record?.snapshot?.id;
            if (recordJobId !== jobId && !key.startsWith(`${jobId}:`)) continue;
            if (record?.status !== 'retrying') continue;
            record.status = 'cancelled';
            record.cancelledAt = cancelledAt;
            record.cancelReason = reason;
            delete record.retry;
            changed = true;
        }
        if (changed) this.persist();
        return changed;
    }

    cancelPendingNotifications(predicate, cancelledAt, reason = 'notification disabled') {
        let changed = false;
        for (const record of Object.values(this.state)) {
            const notifications = record?.notifications;
            if (!notifications || typeof notifications !== 'object') continue;
            for (const [eventType, providers] of Object.entries(notifications)) {
                if (!providers || typeof providers !== 'object') continue;
                for (const [provider, delivery] of Object.entries(providers)) {
                    if (delivery?.status !== 'pending') continue;
                    if (!predicate({ eventType, provider, delivery, record })) continue;
                    delivery.status = 'cancelled';
                    delivery.cancelledAt = cancelledAt;
                    delivery.cancelReason = reason;
                    delete delivery.notification;
                    delete delivery.nextAttemptAt;
                    delete delivery.lastError;
                    changed = true;
                }
            }
        }
        if (changed) this.persist();
        return changed;
    }

    listPendingRetries() {
        return Object.entries(this.state).flatMap(([key, record]) => {
            if (record?.status !== 'retrying' || !record.retry?.nextRetryAt) return [];
            const separator = key.lastIndexOf(':');
            const jobId = record.jobId || record.snapshot?.id || (separator > 0 ? key.slice(0, separator) : '');
            if (!jobId) return [];
            return [{
                key,
                jobId,
                retryAttempt: Number(record.retry.attempt),
                nextRetryAt: record.retry.nextRetryAt
            }];
        }).filter((entry) => Number.isInteger(entry.retryAttempt) && entry.retryAttempt > 0);
    }

    getRunSnapshot(key) {
        const snapshot = this.state[key]?.snapshot;
        return snapshot ? clone(snapshot) : null;
    }

    findUnresolvedScheduledRun(jobId, excludeKey = null) {
        for (const [key, record] of Object.entries(this.state)) {
            if (key === excludeKey || key.startsWith('manual:')) continue;
            const recordJobId = record?.jobId || record?.snapshot?.id;
            if (recordJobId !== jobId && !key.startsWith(`${jobId}:`)) continue;
            if (record?.status === 'running' || record?.status === 'retrying') {
                return { key, status: record.status, retry: record.retry || null };
            }
        }
        return null;
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

    queueNotification(key, eventType, provider, intent, createdAt) {
        const providerRecord = this.ensureNotificationRecord(key, eventType, provider);
        if (providerRecord.status === 'sent') return clone(providerRecord);
        if (!providerRecord.notification) providerRecord.notification = clone(intent.notification);
        providerRecord.status = 'pending';
        providerRecord.createdAt ||= createdAt;
        providerRecord.attempts = Number.isInteger(providerRecord.attempts) ? providerRecord.attempts : 0;
        providerRecord.jobId ||= intent.jobId || null;
        providerRecord.nextAttemptAt ||= createdAt;
        this.persist();
        return clone(providerRecord);
    }

    markNotificationFailed(key, eventType, provider, failedAt, nextAttemptAt, errorMessage) {
        const providerRecord = this.ensureNotificationRecord(key, eventType, provider);
        if (providerRecord.status === 'sent') return;
        providerRecord.status = 'pending';
        providerRecord.attempts = (Number(providerRecord.attempts) || 0) + 1;
        providerRecord.lastAttemptAt = failedAt;
        providerRecord.nextAttemptAt = nextAttemptAt;
        providerRecord.lastError = String(errorMessage || 'Notification delivery failed');
        this.persist();
    }

    markNotificationSent(key, eventType, provider, sentAt) {
        const providerRecord = this.ensureNotificationRecord(key, eventType, provider);
        providerRecord.status = 'sent';
        providerRecord.sentAt = sentAt;
        delete providerRecord.notification;
        delete providerRecord.nextAttemptAt;
        delete providerRecord.lastError;
        this.persist();
    }

    listPendingNotifications(dueBefore = this.now().toISOString()) {
        const pending = [];
        for (const [key, record] of Object.entries(this.state)) {
            const notifications = record?.notifications;
            if (!notifications || typeof notifications !== 'object') continue;
            for (const [eventType, providers] of Object.entries(notifications)) {
                if (!providers || typeof providers !== 'object') continue;
                for (const [provider, delivery] of Object.entries(providers)) {
                    if (delivery?.status !== 'pending' || !delivery.notification) continue;
                    if (delivery.nextAttemptAt && delivery.nextAttemptAt > dueBefore) continue;
                    pending.push({
                        key,
                        eventType,
                        provider,
                        jobId: delivery.jobId || record.jobId || record.snapshot?.id || null,
                        notification: clone(delivery.notification),
                        attempts: Number(delivery.attempts) || 0,
                        nextAttemptAt: delivery.nextAttemptAt || null
                    });
                }
            }
        }
        return pending;
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
            .filter(([key]) => key.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$/.test(key.slice(prefix.length)))
            .sort(([left], [right]) => right.localeCompare(left));
        if (entries.length === 0) return null;

        const [key, record] = entries[0];
        const { sentItems, totalItems } = this.getRunProgress(key, job);
        let status = record.status || 'pending';
        if (status === 'failed' && sentItems > 0 && sentItems < totalItems) status = 'partial';

        return {
            key,
            date: key.slice(prefix.length, prefix.length + 10),
            status,
            sentItems,
            totalItems,
            timestamp: record.sentAt || record.failedAt || record.startedAt || null,
            retry: record.retry || null
        };
    }

    pruneExpired() {
        const cutoff = this.now().getTime() - this.retentionDays * 24 * 60 * 60 * 1000;
        let changed = false;
        for (const [key, record] of Object.entries(this.state)) {
            if (this.isUnresolvedRecord(record)) continue;
            const timestamp = this.recordTimestamp(record);
            if (timestamp === null || timestamp >= cutoff) continue;
            delete this.state[key];
            changed = true;
        }
        return changed;
    }

    isUnresolvedRecord(record) {
        if (record?.status === 'running' || record?.status === 'retrying') return true;
        return Object.values(record?.notifications || {}).some((providers) => (
            Object.values(providers || {}).some((delivery) => delivery?.status === 'pending')
        ));
    }

    recordTimestamp(record) {
        const timestamps = [record?.sentAt, record?.failedAt, record?.startedAt, record?.cancelledAt];
        for (const providers of Object.values(record?.notifications || {})) {
            for (const delivery of Object.values(providers || {})) {
                timestamps.push(delivery?.sentAt, delivery?.lastAttemptAt, delivery?.createdAt, delivery?.cancelledAt);
            }
        }
        const values = timestamps
            .filter(Boolean)
            .map((value) => Date.parse(value))
            .filter(Number.isFinite);
        return values.length > 0 ? Math.max(...values) : null;
    }

    ensureNotificationRecord(key, eventType, provider) {
        const record = this.ensureJobRecord(key);
        if (!record.notifications || typeof record.notifications !== 'object') record.notifications = {};
        if (!record.notifications[eventType] || typeof record.notifications[eventType] !== 'object') {
            record.notifications[eventType] = {};
        }
        const current = record.notifications[eventType][provider];
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
            record.notifications[eventType][provider] = {};
        }
        return record.notifications[eventType][provider];
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

module.exports = {
    DEFAULT_STATE_RETENTION_DAYS,
    StateStore,
    parseStateRetentionDays
};
