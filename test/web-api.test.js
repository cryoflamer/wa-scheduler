const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { loadConfig } = require('../src/config');
const { createWebServer } = require('../src/web/server');

test('local UI API returns jobs and masked recipients', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-web-api-'));
    const configPath = path.join(directory, 'schedule.json');
    const envPath = path.join(directory, '.env');
    fs.writeFileSync(configPath, JSON.stringify({
        timezone: 'Europe/Kyiv',
        jobs: [{
            id: 'report',
            schedule: '0 8 * * 1',
            recipient: '${WA_RECIPIENT_OFFICE}',
            message: 'Report'
        }]
    }));
    fs.writeFileSync(envPath, 'WA_RECIPIENT_OFFICE=380661234567\n');
    process.env.WA_RECIPIENT_OFFICE = '380661234567';

    const schedulerManager = {
        config: loadConfig(configPath),
        apply(config) { this.config = config; }
    };
    const app = createWebServer({
        client: {},
        stateStore: {},
        schedulerManager,
        configPath,
        envPath,
        status: { whatsapp: 'ready' }
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => {
        server.close();
        delete process.env.WA_RECIPIENT_OFFICE;
    });
    const { port } = server.address();

    const jobs = await fetch(`http://127.0.0.1:${port}/api/jobs`).then((response) => response.json());
    const recipients = await fetch(`http://127.0.0.1:${port}/api/recipients`).then((response) => response.json());

    assert.equal(jobs.jobs[0].recipientKey, 'WA_RECIPIENT_OFFICE');
    assert.deepEqual(recipients, [{
        key: 'WA_RECIPIENT_OFFICE',
        name: 'OFFICE',
        maskedNumber: '380******567'
    }]);
});
