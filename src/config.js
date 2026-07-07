const fs = require('fs');
const path = require('path');

const ENVIRONMENT_VARIABLE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function requireNonEmptyString(value, fieldName) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${fieldName} must be a non-empty string`);
    }

    return value;
}

function expandEnvironment(value, fieldName, environment) {
    return value.replace(ENVIRONMENT_VARIABLE_PATTERN, (_, variableName) => {
        const resolved = environment[variableName];

        if (typeof resolved !== 'string' || resolved === '') {
            throw new Error(
                `${fieldName} references missing environment variable: ${variableName}`
            );
        }

        return resolved;
    });
}

function requireExpandedString(value, fieldName, environment) {
    const stringValue = requireNonEmptyString(value, fieldName);
    return expandEnvironment(stringValue, fieldName, environment);
}

function validateJob(job, index, environment) {
    if (!job || typeof job !== 'object' || Array.isArray(job)) {
        throw new Error(`jobs[${index}] must be an object`);
    }

    return {
        id: requireExpandedString(job.id, `jobs[${index}].id`, environment),
        schedule: requireExpandedString(job.schedule, `jobs[${index}].schedule`, environment),
        recipient: requireExpandedString(job.recipient, `jobs[${index}].recipient`, environment),
        file: requireExpandedString(job.file, `jobs[${index}].file`, environment),
        caption: typeof job.caption === 'string'
            ? expandEnvironment(job.caption, `jobs[${index}].caption`, environment)
            : ''
    };
}

function loadConfig(configPath = 'schedule.json', environment = process.env) {
    const resolvedPath = path.resolve(configPath);

    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Schedule configuration does not exist: ${resolvedPath}`);
    }

    const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Schedule configuration must be a JSON object');
    }

    const timezone = requireExpandedString(parsed.timezone, 'timezone', environment);

    if (!Array.isArray(parsed.jobs) || parsed.jobs.length === 0) {
        throw new Error('jobs must be a non-empty array');
    }

    const jobs = parsed.jobs.map((job, index) => validateJob(job, index, environment));
    const ids = new Set();

    for (const job of jobs) {
        if (ids.has(job.id)) {
            throw new Error(`Duplicate job id: ${job.id}`);
        }
        ids.add(job.id);
    }

    return { timezone, jobs };
}

module.exports = {
    expandEnvironment,
    loadConfig
};
