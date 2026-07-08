const fs = require('fs');
const path = require('path');

function parseEnvFile(envPath = '.env') {
    const resolvedPath = path.resolve(envPath);
    if (!fs.existsSync(resolvedPath)) return [];
    return fs.readFileSync(resolvedPath, 'utf8').split(/\r?\n/);
}

function loadEnvValue(key, envPath = '.env') {
    for (const line of parseEnvFile(envPath)) {
        const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*?)\s*$/);
        if (match?.[1] === key) return match[2];
    }
    return '';
}

function saveEnvValue(key, value, envPath = '.env') {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error('Invalid environment variable name');
    const normalized = String(value || '').trim();
    if (!normalized) throw new Error(`${key} must be a non-empty string`);

    const resolvedPath = path.resolve(envPath);
    const lines = parseEnvFile(envPath);
    const assignment = `${key}=${normalized}`;
    const index = lines.findIndex((line) => line.match(/^\s*([^=]+)\s*=/)?.[1].trim() === key);

    if (index >= 0) lines[index] = assignment;
    else {
        if (lines.length > 0 && lines.at(-1) !== '') lines.push('');
        lines.push(assignment);
    }

    fs.writeFileSync(resolvedPath, `${lines.join('\n').replace(/\n+$/, '')}\n`);
    process.env[key] = normalized;
    return normalized;
}

function maskSecret(value) {
    const text = String(value || '');
    if (!text) return '';
    if (text.length <= 8) return '*'.repeat(text.length);
    return `${text.slice(0, 4)}${'*'.repeat(Math.min(text.length - 8, 12))}${text.slice(-4)}`;
}

module.exports = { loadEnvValue, maskSecret, parseEnvFile, saveEnvValue };
