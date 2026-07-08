const fs = require('fs');
const path = require('path');

const ENVIRONMENT_VARIABLE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const DEFAULT_WHATSAPP_NOTIFICATION_EVENTS = [
    'job.completed',
    'job.failed',
    'job.partial',
    'job.retry.scheduled',
    'job.recovered',
    'job.retry.exhausted',
    'job.manual.completed',
    'job.manual.failed',
    'job.manual.partial'
];
const DEFAULT_NTFY_NOTIFICATION_EVENTS = [
    'job.completed',
    'job.failed',
    'job.partial',
    'job.retry.scheduled',
    'job.recovered',
    'job.retry.exhausted',
    'job.manual.completed',
    'job.manual.failed',
    'job.manual.partial',
    'whatsapp.disconnected'
];
const ALLOWED_NOTIFICATION_EVENTS = new Set([
    'job.completed',
    'job.failed',
    'job.partial',
    'job.retry.scheduled',
    'job.recovered',
    'job.retry.exhausted',
    'job.manual.completed',
    'job.manual.failed',
    'job.manual.partial',
    'whatsapp.disconnected'
]);

const MANUAL_EVENT_BY_SCHEDULED_EVENT = {
    'job.completed': 'job.manual.completed',
    'job.failed': 'job.manual.failed',
    'job.partial': 'job.manual.partial'
};

function upgradeLegacyNotificationEvents(events, version) {
    const configVersion = Number(version || 1);
    const upgraded = [...events];

    if (configVersion < 2) {
        for (const event of events) {
            const manualEvent = MANUAL_EVENT_BY_SCHEDULED_EVENT[event];
            if (manualEvent && !upgraded.includes(manualEvent)) upgraded.push(manualEvent);
        }
    }

    if (configVersion < 3) {
        if ((events.includes('job.failed') || events.includes('job.partial')) && !upgraded.includes('job.retry.scheduled')) {
            upgraded.push('job.retry.scheduled');
        }
        if (events.includes('job.completed') && !upgraded.includes('job.recovered')) {
            upgraded.push('job.recovered');
        }
        if ((events.includes('job.failed') || events.includes('job.partial')) && !upgraded.includes('job.retry.exhausted')) {
            upgraded.push('job.retry.exhausted');
        }
    }

    return upgraded;
}

function normalizeNotificationEvents(value, fieldName, defaults) {
    if (value === undefined) return [...defaults];
    if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array`);
    const events = value.map((event, index) => requireNonEmptyString(event, `${fieldName}[${index}]`));
    for (const event of events) {
        if (!ALLOWED_NOTIFICATION_EVENTS.has(event)) {
            throw new Error(`${fieldName} contains unsupported event: ${event}`);
        }
    }
    return [...new Set(events)];
}

function normalizeNotifications(value, environment) {
    const notifications = value === undefined ? {} : value;
    if (!notifications || typeof notifications !== 'object' || Array.isArray(notifications)) {
        throw new Error('notifications must be an object');
    }

    const whatsappRaw = notifications.whatsapp || {};
    const ntfyRaw = notifications.ntfy || {};
    const whatsappEnabled = whatsappRaw.enabled === undefined ? false : requireBoolean(whatsappRaw.enabled, 'notifications.whatsapp.enabled');
    const ntfyEnabled = ntfyRaw.enabled === undefined ? false : requireBoolean(ntfyRaw.enabled, 'notifications.ntfy.enabled');

    const whatsapp = {
        enabled: whatsappEnabled,
        recipient: whatsappEnabled
            ? requireExpandedString(whatsappRaw.recipient, 'notifications.whatsapp.recipient', environment)
            : '',
        events: upgradeLegacyNotificationEvents(normalizeNotificationEvents(
            whatsappRaw.events,
            'notifications.whatsapp.events',
            DEFAULT_WHATSAPP_NOTIFICATION_EVENTS
        ), notifications.version),
        includeMessage: whatsappRaw.includeMessage === undefined
            ? false
            : requireBoolean(whatsappRaw.includeMessage, 'notifications.whatsapp.includeMessage')
    };
    const ntfy = {
        enabled: ntfyEnabled,
        server: ntfyEnabled
            ? requireExpandedString(ntfyRaw.server, 'notifications.ntfy.server', environment)
            : String(ntfyRaw.server || 'https://ntfy.sh'),
        topic: ntfyEnabled
            ? requireExpandedString(ntfyRaw.topic, 'notifications.ntfy.topic', environment)
            : '',
        events: upgradeLegacyNotificationEvents(normalizeNotificationEvents(
            ntfyRaw.events,
            'notifications.ntfy.events',
            DEFAULT_NTFY_NOTIFICATION_EVENTS
        ), notifications.version),
        includeMessage: ntfyRaw.includeMessage === undefined
            ? false
            : requireBoolean(ntfyRaw.includeMessage, 'notifications.ntfy.includeMessage')
    };

    return { whatsapp, ntfy };
}

function requireNonEmptyString(value, fieldName) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${fieldName} must be a non-empty string`);
    }

    return value;
}

function requireBoolean(value, fieldName) {
    if (typeof value !== 'boolean') {
        throw new Error(`${fieldName} must be a boolean`);
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


function normalizeRetry(value, fieldName) {
    if (value === undefined) return { attempts: 0, delayMinutes: 10 };
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${fieldName} must be an object`);
    }

    const attempts = value.attempts === undefined ? 0 : Number(value.attempts);
    const delayMinutes = value.delayMinutes === undefined ? 10 : Number(value.delayMinutes);
    if (!Number.isInteger(attempts) || attempts < 0 || attempts > 20) {
        throw new Error(`${fieldName}.attempts must be an integer between 0 and 20`);
    }
    if (!Number.isInteger(delayMinutes) || delayMinutes < 1 || delayMinutes > 1440) {
        throw new Error(`${fieldName}.delayMinutes must be an integer between 1 and 1440`);
    }
    return { attempts, delayMinutes };
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
        enabled: job.enabled === undefined ? true : requireBoolean(job.enabled, `jobs[${index}].enabled`),
        retry: normalizeRetry(job.retry, `jobs[${index}].retry`),
        message,
        files
    };
}

function ensureLocalConfig(configPath = 'schedule.json', examplePath = 'schedule.example.json') {
    const resolvedPath = path.resolve(configPath);

    if (fs.existsSync(resolvedPath)) {
        return false;
    }

    const resolvedExamplePath = path.resolve(examplePath);
    if (!fs.existsSync(resolvedExamplePath)) {
        throw new Error(
            `Schedule configuration does not exist and no example is available: ${resolvedPath}`
        );
    }

    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.copyFileSync(resolvedExamplePath, resolvedPath, fs.constants.COPYFILE_EXCL);
    return true;
}

function loadRawConfig(configPath = 'schedule.json') {
    const resolvedPath = path.resolve(configPath);

    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Schedule configuration does not exist: ${resolvedPath}`);
    }

    const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Schedule configuration must be a JSON object');
    }

    return parsed;
}

function normalizeConfig(parsed, environment = process.env) {
    const timezone = requireExpandedString(parsed.timezone, 'timezone', environment);

    if (!Array.isArray(parsed.jobs)) {
        throw new Error('jobs must be an array');
    }

    const jobs = parsed.jobs.map((job, index) => validateJob(job, index, environment));
    const ids = new Set();

    for (const job of jobs) {
        if (ids.has(job.id)) {
            throw new Error(`Duplicate job id: ${job.id}`);
        }
        ids.add(job.id);
    }

    const notifications = normalizeNotifications(parsed.notifications, environment);

    return { timezone, notifications, jobs };
}

function loadConfig(configPath = 'schedule.json', environment = process.env) {
    return normalizeConfig(loadRawConfig(configPath), environment);
}

function saveRawConfig(config, configPath = 'schedule.json') {
    const resolvedPath = path.resolve(configPath);
    const temporaryPath = `${resolvedPath}.tmp`;

    fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`);
    fs.renameSync(temporaryPath, resolvedPath);
}

module.exports = {
    ensureLocalConfig,
    expandEnvironment,
    loadConfig,
    loadRawConfig,
    normalizeConfig,
    normalizeNotifications,
    saveRawConfig,
    upgradeLegacyNotificationEvents
};
