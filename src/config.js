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

function optionalExpandedString(value, fieldName, environment) {
    if (value === undefined) {
        return '';
    }

    if (typeof value !== 'string') {
        throw new Error(`${fieldName} must be a string`);
    }

    return expandEnvironment(value, fieldName, environment);
}

function normalizeFile(file, fieldName, environment) {
    if (typeof file === 'string') {
        return {
            path: requireExpandedString(file, fieldName, environment),
            caption: ''
        };
    }

    if (!file || typeof file !== 'object' || Array.isArray(file)) {
        throw new Error(`${fieldName} must be a string or an object`);
    }

    return {
        path: requireExpandedString(file.path, `${fieldName}.path`, environment),
        caption: optionalExpandedString(file.caption, `${fieldName}.caption`, environment)
    };
}

function normalizeFiles(job, index, environment) {
    if (job.files !== undefined && job.file !== undefined) {
        throw new Error(`jobs[${index}] cannot define both file and files`);
    }

    let files;

    if (job.files !== undefined) {
        if (!Array.isArray(job.files)) {
            throw new Error(`jobs[${index}].files must be an array`);
        }

        files = job.files.map((file, fileIndex) => normalizeFile(
            file,
            `jobs[${index}].files[${fileIndex}]`,
            environment
        ));
    } else if (job.file !== undefined) {
        files = [{
            path: requireExpandedString(job.file, `jobs[${index}].file`, environment),
            caption: optionalExpandedString(job.caption, `jobs[${index}].caption`, environment)
        }];
    } else {
        files = [];
    }

    const paths = new Set();

    for (const file of files) {
        if (paths.has(file.path)) {
            throw new Error(`jobs[${index}] contains duplicate file path: ${file.path}`);
        }
        paths.add(file.path);
    }

    return files;
}

function validateJob(job, index, environment) {
    if (!job || typeof job !== 'object' || Array.isArray(job)) {
        throw new Error(`jobs[${index}] must be an object`);
    }

    const message = optionalExpandedString(job.message, `jobs[${index}].message`, environment);
    const files = normalizeFiles(job, index, environment);

    if (message.trim() === '' && files.length === 0) {
        throw new Error(`jobs[${index}] must define a non-empty message or at least one file`);
    }

    return {
        id: requireExpandedString(job.id, `jobs[${index}].id`, environment),
        schedule: requireExpandedString(job.schedule, `jobs[${index}].schedule`, environment),
        recipient: requireExpandedString(job.recipient, `jobs[${index}].recipient`, environment),
        message,
        files
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
