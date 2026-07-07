const fs = require('fs');
const path = require('path');

function requireNonEmptyString(value, fieldName) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${fieldName} must be a non-empty string`);
    }

    return value;
}

function validateJob(job, index) {
    if (!job || typeof job !== 'object' || Array.isArray(job)) {
        throw new Error(`jobs[${index}] must be an object`);
    }

    return {
        id: requireNonEmptyString(job.id, `jobs[${index}].id`),
        schedule: requireNonEmptyString(job.schedule, `jobs[${index}].schedule`),
        recipient: requireNonEmptyString(job.recipient, `jobs[${index}].recipient`),
        file: requireNonEmptyString(job.file, `jobs[${index}].file`),
        caption: typeof job.caption === 'string' ? job.caption : ''
    };
}

function loadConfig(configPath = 'config/schedule.json') {
    const resolvedPath = path.resolve(configPath);

    if (!fs.existsSync(resolvedPath)) {
        throw new Error(
            `Schedule configuration does not exist: ${resolvedPath}. ` +
            'Copy config/schedule.example.json to config/schedule.json and edit it.'
        );
    }

    const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Schedule configuration must be a JSON object');
    }

    const timezone = requireNonEmptyString(parsed.timezone, 'timezone');

    if (!Array.isArray(parsed.jobs) || parsed.jobs.length === 0) {
        throw new Error('jobs must be a non-empty array');
    }

    const jobs = parsed.jobs.map(validateJob);
    const ids = new Set();

    for (const job of jobs) {
        if (ids.has(job.id)) {
            throw new Error(`Duplicate job id: ${job.id}`);
        }
        ids.add(job.id);
    }

    return { timezone, jobs };
}

module.exports = { loadConfig };
