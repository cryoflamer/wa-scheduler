const fs = require('fs');
const path = require('path');

const PREFIX = 'WA_RECIPIENT_';
const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function envKeyFor(name) {
    const key = String(name || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');

    if (!KEY_PATTERN.test(key)) {
        throw new Error('Recipient name must contain letters or numbers');
    }

    return `${PREFIX}${key}`;
}

function parseEnvFile(envPath = '.env') {
    const resolvedPath = path.resolve(envPath);
    if (!fs.existsSync(resolvedPath)) {
        return [];
    }

    return fs.readFileSync(resolvedPath, 'utf8').split(/\r?\n/);
}

function loadRecipients(envPath = '.env') {
    const recipients = [];

    for (const line of parseEnvFile(envPath)) {
        const match = line.match(/^\s*(WA_RECIPIENT_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (!match) {
            continue;
        }

        recipients.push({
            key: match[1],
            name: match[1].slice(PREFIX.length),
            number: match[2]
        });
    }

    return recipients;
}

function saveRecipient(name, number, envPath = '.env') {
    const key = envKeyFor(name);
    const normalizedNumber = String(number || '').replace(/[^\d]/g, '');

    if (normalizedNumber.length < 7) {
        throw new Error('Recipient number must contain at least 7 digits');
    }

    const resolvedPath = path.resolve(envPath);
    const lines = parseEnvFile(envPath);
    const assignment = `${key}=${normalizedNumber}`;
    const index = lines.findIndex((line) => line.match(/^\s*([^=]+)\s*=/)?.[1].trim() === key);

    if (index >= 0) {
        lines[index] = assignment;
    } else {
        if (lines.length > 0 && lines.at(-1) !== '') {
            lines.push('');
        }
        lines.push(assignment);
    }

    fs.writeFileSync(resolvedPath, `${lines.join('\n').replace(/\n+$/, '')}\n`);
    process.env[key] = normalizedNumber;

    return { key, name: key.slice(PREFIX.length), number: normalizedNumber };
}

function deleteRecipient(key, envPath = '.env') {
    if (!String(key).startsWith(PREFIX)) {
        throw new Error('Invalid recipient key');
    }

    const resolvedPath = path.resolve(envPath);
    const lines = parseEnvFile(envPath);
    const filtered = lines.filter((line) => line.match(/^\s*([^=]+)\s*=/)?.[1].trim() !== key);

    fs.writeFileSync(resolvedPath, `${filtered.join('\n').replace(/\n+$/, '')}\n`);
    delete process.env[key];
}

function maskNumber(number) {
    const value = String(number || '');
    if (value.length <= 6) {
        return '*'.repeat(value.length);
    }
    return `${value.slice(0, 3)}${'*'.repeat(value.length - 6)}${value.slice(-3)}`;
}

module.exports = {
    deleteRecipient,
    envKeyFor,
    loadRecipients,
    maskNumber,
    saveRecipient
};
