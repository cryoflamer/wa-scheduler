const crypto = require('crypto');

function zonedDateTimeKey(date, timezone) {
    const parts = new Intl.DateTimeFormat('en', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));

    return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function dateKey(date, timezone) {
    return zonedDateTimeKey(date, timezone).slice(0, 10);
}

function occurrenceKey(jobId, date, timezone) {
    return `${jobId}:${zonedDateTimeKey(date, timezone)}`;
}

function createJobSnapshot(job) {
    return {
        id: String(job.id),
        recipient: String(job.recipient),
        message: String(job.message || ''),
        files: Array.isArray(job.files)
            ? job.files.map((file) => ({
                path: String(file.path),
                caption: String(file.caption || '')
            }))
            : [],
        retry: {
            attempts: Number(job?.retry?.attempts || 0),
            delayMinutes: Number(job?.retry?.delayMinutes || 10)
        }
    };
}

function fingerprintJobSnapshot(snapshot) {
    return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

module.exports = {
    createJobSnapshot,
    dateKey,
    fingerprintJobSnapshot,
    occurrenceKey,
    zonedDateTimeKey
};
