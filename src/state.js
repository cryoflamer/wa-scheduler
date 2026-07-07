const fs = require('fs');
const path = require('path');

class StateStore {
    constructor(statePath = 'data/state.json') {
        this.statePath = path.resolve(statePath);
        this.state = this.load();
    }

    load() {
        if (!fs.existsSync(this.statePath)) {
            return {};
        }

        const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(`Invalid scheduler state: ${this.statePath}`);
        }

        return parsed;
    }

    has(key) {
        return Object.prototype.hasOwnProperty.call(this.state, key);
    }

    isComplete(key) {
        return this.state[key]?.status === 'sent';
    }

    isMessageSent(key) {
        return this.state[key]?.message?.status === 'sent';
    }

    isFileSent(key, filePath) {
        return this.state[key]?.files?.[filePath]?.status === 'sent';
    }

    markMessageSent(key, sentAt) {
        const record = this.ensureJobRecord(key);
        record.message = {
            status: 'sent',
            sentAt
        };
        this.persist();
    }

    markFileSent(key, filePath, sentAt) {
        const record = this.ensureJobRecord(key);
        record.files[filePath] = {
            status: 'sent',
            sentAt
        };
        this.persist();
    }

    markComplete(key, sentAt) {
        const record = this.ensureJobRecord(key);
        record.status = 'sent';
        record.sentAt = sentAt;
        this.persist();
    }

    // Kept for callers and state written by the original single-document scheduler.
    markSent(key, sentAt) {
        this.state[key] = {
            status: 'sent',
            sentAt
        };
        this.persist();
    }

    ensureJobRecord(key) {
        const current = this.state[key];

        if (!current || typeof current !== 'object' || Array.isArray(current)) {
            this.state[key] = {};
        }

        if (!this.state[key].files || typeof this.state[key].files !== 'object') {
            this.state[key].files = {};
        }

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
