const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { ActivityLog, safeErrorMessage } = require('../src/activity');

test('activity events are persisted, filtered, and cleared', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-activity-'));
    const activityPath = path.join(directory, 'activity.jsonl');
    const activity = new ActivityLog(activityPath);
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};

    try {
        activity.info('whatsapp.ready', { message: 'WhatsApp ready' });
        activity.sent('job.file.sent', {
            jobId: 'report',
            message: 'report.pdf sent',
            details: { file: 'report.pdf' }
        });
        activity.skipped('job.skipped', {
            jobId: 'report',
            message: 'Already sent for this date; skipping'
        });
    } finally {
        console.log = originalLog;
        console.warn = originalWarn;
    }

    assert.equal(activity.list().length, 3);
    assert.equal(activity.list({ filter: 'jobs' }).length, 2);
    assert.equal(activity.list({ filter: 'whatsapp' }).length, 1);
    assert.equal(activity.list({ filter: 'errors' }).length, 0);
    assert.equal(activity.list()[0].type, 'job.skipped');
    assert.equal(activity.list()[1].details.file, 'report.pdf');

    activity.clear();
    assert.deepEqual(activity.list(), []);
    assert.equal(fs.readFileSync(activityPath, 'utf8'), '');
});

test('activity errors hide local absolute paths', () => {
    const cwd = path.resolve('.');
    const message = safeErrorMessage(new Error(`Document does not exist: ${cwd}/documents/report.pdf`));

    assert.equal(message, 'Document does not exist: ./documents/report.pdf');
    assert.equal(message.includes(cwd), false);
});

test('activity subscribers receive new events and clear notifications', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-activity-'));
    const activity = new ActivityLog(path.join(directory, 'activity.jsonl'));
    const received = [];
    let cleared = 0;
    const originalLog = console.log;
    console.log = () => {};
    const unsubscribe = activity.subscribe((event) => received.push(event.type));
    const unsubscribeClear = activity.onClear(() => { cleared += 1; });

    try {
        activity.info('job.started', { jobId: 'report', message: 'Job started' });
        activity.clear();
    } finally {
        unsubscribe();
        unsubscribeClear();
        console.log = originalLog;
    }

    assert.deepEqual(received, ['job.started']);
    assert.equal(cleared, 1);
});
