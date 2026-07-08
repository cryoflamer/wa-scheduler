const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const crypto = require('crypto');

function safeErrorMessage(error) {
    let message = error instanceof Error ? error.message : String(error);
    const cwd = path.resolve('.');
    const home = process.env.HOME ? path.resolve(process.env.HOME) : null;

    if (cwd) {
        message = message.split(cwd).join('.');
    }
    if (home) {
        message = message.split(home).join('~');
    }

    return message;
}

function retentionDays(value = process.env.WA_ACTIVITY_RETENTION_DAYS) {
    const days = value === undefined || value === '' ? 30 : Number(value);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
        throw new Error('WA_ACTIVITY_RETENTION_DAYS must be an integer between 1 and 3650');
    }
    return days;
}

class ActivityLog {
    constructor(activityPath = process.env.WA_ACTIVITY_FILE || 'data/activity.jsonl', options = {}) {
        this.activityPath = path.resolve(activityPath);
        this.retentionDays = retentionDays(options.retentionDays);
        this.events = new EventEmitter();
        this.prune();
    }

    write(level, type, fields = {}) {
        const event = {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            level,
            type,
            message: fields.message || type,
            ...(fields.jobId ? { jobId: fields.jobId } : {}),
            ...(fields.details ? { details: fields.details } : {})
        };

        fs.mkdirSync(path.dirname(this.activityPath), { recursive: true });
        fs.appendFileSync(this.activityPath, `${JSON.stringify(event)}\n`);
        this.events.emit('event', event);
        this.print(event);
        return event;
    }

    info(type, fields) {
        return this.write('info', type, fields);
    }

    sent(type, fields) {
        return this.write('sent', type, fields);
    }

    skipped(type, fields) {
        return this.write('skipped', type, fields);
    }

    error(type, fields = {}) {
        const message = fields.error ? safeErrorMessage(fields.error) : fields.message;
        return this.write('error', type, { ...fields, message });
    }

    list({ limit = 100, filter = 'all' } = {}) {
        const normalizedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
        const events = this.readAll().filter((event) => {
            if (filter === 'all') return true;
            if (filter === 'jobs') return event.type.startsWith('job.');
            if (filter === 'whatsapp') return event.type.startsWith('whatsapp.');
            if (filter === 'errors') return event.level === 'error';
            return true;
        });

        return events.slice(-normalizedLimit).reverse();
    }

    prune(now = new Date()) {
        if (!fs.existsSync(this.activityPath)) return 0;
        const events = this.readAll();
        const cutoff = now.getTime() - this.retentionDays * 24 * 60 * 60 * 1000;
        const kept = events.filter((event) => {
            const timestamp = new Date(event.timestamp).getTime();
            return Number.isFinite(timestamp) && timestamp >= cutoff;
        });
        const removed = events.length - kept.length;
        if (removed > 0) {
            fs.mkdirSync(path.dirname(this.activityPath), { recursive: true });
            const temporaryPath = `${this.activityPath}.tmp`;
            fs.writeFileSync(temporaryPath, kept.map((event) => JSON.stringify(event)).join('\n') + (kept.length ? '\n' : ''));
            fs.renameSync(temporaryPath, this.activityPath);
        }
        return removed;
    }

    clear() {
        fs.mkdirSync(path.dirname(this.activityPath), { recursive: true });
        fs.writeFileSync(this.activityPath, '');
        this.events.emit('clear');
    }

    subscribe(listener) {
        this.events.on('event', listener);
        return () => this.events.off('event', listener);
    }

    onClear(listener) {
        this.events.on('clear', listener);
        return () => this.events.off('clear', listener);
    }

    readAll() {
        if (!fs.existsSync(this.activityPath)) {
            return [];
        }

        return fs.readFileSync(this.activityPath, 'utf8')
            .split('\n')
            .filter(Boolean)
            .flatMap((line) => {
                try {
                    return [JSON.parse(line)];
                } catch {
                    return [];
                }
            });
    }

    print(event) {
        const prefix = event.jobId ? `Job ${event.jobId}: ` : '';
        const line = `${prefix}${event.message}`;
        if (event.level === 'error') {
            console.error(line);
        } else if (event.level === 'skipped') {
            console.warn(line);
        } else {
            console.log(line);
        }
    }
}

module.exports = { ActivityLog, retentionDays, safeErrorMessage };
