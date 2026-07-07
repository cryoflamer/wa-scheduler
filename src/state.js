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

    markSent(key, sentAt) {
        this.state[key] = {
            status: 'sent',
            sentAt
        };

        this.persist();
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
