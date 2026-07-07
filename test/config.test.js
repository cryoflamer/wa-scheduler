const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadConfig } = require('../src/config');

test('schedule configuration is loaded and normalized', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-scheduler-config-'));
    const configPath = path.join(directory, 'schedule.json');

    try {
        fs.writeFileSync(configPath, JSON.stringify({
            timezone: 'Europe/Kyiv',
            jobs: [{
                id: 'report',
                schedule: '0 8 * * 1',
                recipient: '+380 66 000 00 00',
                file: 'documents/report.pdf'
            }]
        }));

        assert.deepEqual(loadConfig(configPath), {
            timezone: 'Europe/Kyiv',
            jobs: [{
                id: 'report',
                schedule: '0 8 * * 1',
                recipient: '+380 66 000 00 00',
                file: 'documents/report.pdf',
                caption: ''
            }]
        });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('duplicate job ids are rejected', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-scheduler-config-'));
    const configPath = path.join(directory, 'schedule.json');
    const job = {
        id: 'report',
        schedule: '0 8 * * 1',
        recipient: '380660000000',
        file: 'documents/report.pdf'
    };

    try {
        fs.writeFileSync(configPath, JSON.stringify({
            timezone: 'Europe/Kyiv',
            jobs: [job, job]
        }));

        assert.throws(() => loadConfig(configPath), /Duplicate job id: report/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
