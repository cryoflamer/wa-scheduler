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

test('schedule configuration normalizes message and files', () => {
    withConfig({
        timezone: 'Europe/Kyiv',
        jobs: [{
            id: 'report',
            schedule: '0 8 * * 1',
            recipient: '+380 66 000 00 00',
            message: 'Reports are attached',
            files: [
                'documents/report.pdf',
                { path: 'documents/table.xlsx', caption: 'Appendix 1' }
            ]
        }]
    }, (configPath) => {
        assert.deepEqual(loadConfig(configPath, {}), {
            timezone: 'Europe/Kyiv',
            jobs: [{
                id: 'report',
                schedule: '0 8 * * 1',
                recipient: '+380 66 000 00 00',
                message: 'Reports are attached',
                files: [
                    { path: 'documents/report.pdf', caption: '' },
                    { path: 'documents/table.xlsx', caption: 'Appendix 1' }
                ]
            }]
        });
    });
});

test('legacy single-document configuration is normalized', () => {
    withConfig({
        timezone: 'Europe/Kyiv',
        jobs: [{
            id: 'report',
            schedule: '0 8 * * 1',
            recipient: '380660000000',
            file: 'documents/report.pdf',
            caption: 'Report'
        }]
    }, (configPath) => {
        assert.deepEqual(loadConfig(configPath, {}).jobs[0], {
            id: 'report',
            schedule: '0 8 * * 1',
            recipient: '380660000000',
            message: '',
            files: [{ path: 'documents/report.pdf', caption: 'Report' }]
        });
    });
});

test('environment variables are expanded in nested schedule values', () => {
    withConfig({
        timezone: 'Europe/Kyiv',
        jobs: [{
            id: 'report',
            schedule: '0 8 * * 1',
            recipient: '${WA_RECIPIENT_REPORT}',
            message: 'Report for ${WA_REPORT_LABEL}',
            files: [{
                path: 'documents/${WA_REPORT_FILE}',
                caption: '${WA_REPORT_CAPTION}'
            }]
        }]
    }, (configPath) => {
        const config = loadConfig(configPath, {
            WA_RECIPIENT_REPORT: '380660000000',
            WA_REPORT_FILE: 'report.pdf',
            WA_REPORT_LABEL: 'Monday',
            WA_REPORT_CAPTION: 'Appendix'
        });

        assert.deepEqual(config.jobs[0], {
            id: 'report',
            schedule: '0 8 * * 1',
            recipient: '380660000000',
            message: 'Report for Monday',
            files: [{ path: 'documents/report.pdf', caption: 'Appendix' }]
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
            message: 'Report'
        }]
    }, (configPath) => {
        assert.throws(
            () => loadConfig(configPath, {}),
            /jobs\[0\]\.recipient references missing environment variable: WA_RECIPIENT_REPORT/
        );
    });
});

test('jobs without message or files are rejected', () => {
    withConfig({
        timezone: 'Europe/Kyiv',
        jobs: [{
            id: 'report',
            schedule: '0 8 * * 1',
            recipient: '380660000000'
        }]
    }, (configPath) => {
        assert.throws(
            () => loadConfig(configPath, {}),
            /must define a non-empty message or at least one file/
        );
    });
});

test('duplicate file paths are rejected', () => {
    withConfig({
        timezone: 'Europe/Kyiv',
        jobs: [{
            id: 'report',
            schedule: '0 8 * * 1',
            recipient: '380660000000',
            files: ['documents/report.pdf', 'documents/report.pdf']
        }]
    }, (configPath) => {
        assert.throws(
            () => loadConfig(configPath, {}),
            /contains duplicate file path: documents\/report.pdf/
        );
    });
});

test('duplicate job ids are rejected', () => {
    const job = {
        id: 'report',
        schedule: '0 8 * * 1',
        recipient: '380660000000',
        message: 'Report'
    };

    withConfig({
        timezone: 'Europe/Kyiv',
        jobs: [job, job]
    }, (configPath) => {
        assert.throws(() => loadConfig(configPath, {}), /Duplicate job id: report/);
    });
});
