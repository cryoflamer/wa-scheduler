const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { ActivityLog } = require('../src/activity');
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

    const activity = new ActivityLog(path.join(directory, 'activity.jsonl'));
    const originalLog = console.log;
    console.log = () => {};
    activity.info('whatsapp.ready', { message: 'WhatsApp ready' });
    activity.sent('job.completed', { jobId: 'report', message: 'Job completed' });
    console.log = originalLog;

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
        status: { whatsapp: 'ready' },
        activity
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
    const activityEvents = await fetch(`http://127.0.0.1:${port}/api/activity?filter=jobs`).then((response) => response.json());

    assert.equal(jobs.jobs[0].recipientKey, 'WA_RECIPIENT_OFFICE');
    assert.deepEqual(activityEvents.map((event) => event.type), ['job.completed']);
    assert.deepEqual(recipients, [{
        key: 'WA_RECIPIENT_OFFICE',
        name: 'OFFICE',
        maskedNumber: '380******567'
    }]);
});

test('activity SSE streams new events and clear notifications', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-web-activity-'));
    const configPath = path.join(directory, 'schedule.json');
    const activity = new ActivityLog(path.join(directory, 'activity.jsonl'));
    fs.writeFileSync(configPath, JSON.stringify({
        timezone: 'Europe/Kyiv',
        jobs: [{
            id: 'report',
            schedule: '0 8 * * 1',
            recipient: '${WA_RECIPIENT_OFFICE}',
            message: 'Report'
        }]
    }));
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
        status: { whatsapp: 'ready' },
        activity
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const controller = new AbortController();
    t.after(() => {
        controller.abort();
        server.close();
        delete process.env.WA_RECIPIENT_OFFICE;
    });

    const response = await fetch(`http://127.0.0.1:${port}/api/activity/stream`, {
        signal: controller.signal
    });
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const originalLog = console.log;
    console.log = () => {};

    try {
        activity.info('job.started', { jobId: 'report', message: 'Job started' });
        const first = decoder.decode((await reader.read()).value);
        assert.match(first, /"type":"job\.started"/);

        activity.clear();
        const second = decoder.decode((await reader.read()).value);
        assert.match(second, /event: clear/);
    } finally {
        console.log = originalLog;
    }
});
