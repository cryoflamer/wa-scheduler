const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadConfig } = require('../src/config');

function withConfig(config, callback) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-scheduler-config-'));
    const configPath = path.join(directory, 'schedule.json');

    try {
        fs.writeFileSync(configPath, JSON.stringify(config));
        return callback(configPath);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test('schedule configuration is loaded and normalized', () => {
    withConfig({
        timezone: 'Europe/Kyiv',
        jobs: [{
            id: 'report',
            schedule: '0 8 * * 1',
            recipient: '+380 66 000 00 00',
            file: 'documents/report.pdf'
        }]
    }, (configPath) => {
        assert.deepEqual(loadConfig(configPath, {}), {
            timezone: 'Europe/Kyiv',
            jobs: [{
                id: 'report',
                schedule: '0 8 * * 1',
                recipient: '+380 66 000 00 00',
                file: 'documents/report.pdf',
                caption: ''
            }]
        });
    });
});

test('environment variables are expanded in schedule values', () => {
    withConfig({
        timezone: 'Europe/Kyiv',
        jobs: [{
            id: 'report',
            schedule: '0 8 * * 1',
            recipient: '${WA_RECIPIENT_REPORT}',
            file: 'documents/${WA_REPORT_FILE}',
            caption: 'Report for ${WA_REPORT_LABEL}'
        }]
    }, (configPath) => {
        const config = loadConfig(configPath, {
            WA_RECIPIENT_REPORT: '380660000000',
            WA_REPORT_FILE: 'report.pdf',
            WA_REPORT_LABEL: 'Monday'
        });

        assert.deepEqual(config.jobs[0], {
            id: 'report',
            schedule: '0 8 * * 1',
            recipient: '380660000000',
            file: 'documents/report.pdf',
            caption: 'Report for Monday'
        });
    });
});

test('missing environment variables are rejected', () => {
    withConfig({
        timezone: 'Europe/Kyiv',
        jobs: [{
            id: 'report',
            schedule: '0 8 * * 1',
            recipient: '${WA_RECIPIENT_REPORT}',
            file: 'documents/report.pdf'
        }]
    }, (configPath) => {
        assert.throws(
            () => loadConfig(configPath, {}),
            /jobs\[0\]\.recipient references missing environment variable: WA_RECIPIENT_REPORT/
        );
    });
});

test('duplicate job ids are rejected', () => {
    const job = {
        id: 'report',
        schedule: '0 8 * * 1',
        recipient: '380660000000',
        file: 'documents/report.pdf'
    };

    withConfig({
        timezone: 'Europe/Kyiv',
        jobs: [job, job]
    }, (configPath) => {
        assert.throws(() => loadConfig(configPath, {}), /Duplicate job id: report/);
    });
});
