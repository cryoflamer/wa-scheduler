const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    dateKey, latestCronOccurrence, occurrenceKey, parseMissedRunCatchUpHours,
    registerJobs, runJob, SchedulerManager
} = require('../src/scheduler');
const { StateStore } = require('../src/state');

function withState(callback) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-scheduler-run-'));
    const statePath = path.join(directory, 'state.json');

    return Promise.resolve()
        .then(() => callback(new StateStore(statePath), statePath))
        .finally(() => fs.rmSync(directory, { recursive: true, force: true }));
}

test('dateKey uses the configured timezone', () => {
    const date = new Date('2026-07-12T21:30:00.000Z');

    assert.equal(dateKey(date, 'Europe/Kyiv'), '2026-07-13');
});

test('multi-item job sends message and files in order', async () => {
    await withState(async (stateStore) => {
        const calls = [];
        const job = {
            id: 'report',
            recipient: '380660000000',
            message: 'Reports are attached',
            files: [
                { path: 'documents/report.pdf', caption: '' },
                { path: 'documents/table.xlsx', caption: 'Appendix' }
            ]
        };

        await runJob({}, job, stateStore, 'report:2026-07-13', {
            sendText: async (_client, recipient, message) => {
                calls.push(['message', recipient, message]);
            },
            sendFile: async (_client, recipient, file) => {
                calls.push(['file', recipient, file.path, file.caption]);
                return file.path;
            }
        });

        assert.deepEqual(calls, [
            ['message', '380660000000', 'Reports are attached'],
            ['file', '380660000000', 'documents/report.pdf', ''],
            ['file', '380660000000', 'documents/table.xlsx', 'Appendix']
        ]);
        assert.equal(stateStore.isComplete('report:2026-07-13'), true);
    });
});

test('partially sent job resumes from the first unsent item', async () => {
    await withState(async (stateStore, statePath) => {
        const key = 'report:2026-07-13';
        const job = {
            id: 'report',
            recipient: '380660000000',
            message: 'Reports are attached',
            files: [
                { path: 'documents/report.pdf', caption: '' },
                { path: 'documents/table.xlsx', caption: '' }
            ]
        };
        const firstCalls = [];

        await assert.rejects(
            () => runJob({}, job, stateStore, key, {
                sendText: async () => firstCalls.push('message'),
                sendFile: async (_client, _recipient, file) => {
                    firstCalls.push(file.path);
                    if (file.path.endsWith('table.xlsx')) {
                        throw new Error('temporary failure');
                    }
                    return file.path;
                }
            }),
            /temporary failure/
        );

        assert.deepEqual(firstCalls, [
            'message',
            'documents/report.pdf',
            'documents/table.xlsx'
        ]);

        const resumedStore = new StateStore(statePath);
        const resumedCalls = [];

        await runJob({}, job, resumedStore, key, {
            sendText: async () => resumedCalls.push('message'),
            sendFile: async (_client, _recipient, file) => {
                resumedCalls.push(file.path);
                return file.path;
            }
        });

        assert.deepEqual(resumedCalls, ['documents/table.xlsx']);
        assert.equal(resumedStore.isComplete(key), true);
    });
});

test('legacy completed state skips the entire job', async () => {
    await withState(async (stateStore) => {
        const key = 'report:2026-07-13';
        stateStore.markSent(key, '2026-07-13T05:00:03.000Z');
        let sendCount = 0;

        const result = await runJob({}, {
            id: 'report',
            recipient: '380660000000',
            message: 'Report',
            files: []
        }, stateStore, key, {
            sendText: async () => {
                sendCount += 1;
            }
        });

        assert.equal(result.status, 'skipped');
        assert.equal(sendCount, 0);
    });
});

test('job execution emits structured activity without recipient or message contents', async () => {
    await withState(async (stateStore) => {
        const events = [];
        const activity = {
            info(type, fields) { events.push({ level: 'info', type, ...fields }); },
            sent(type, fields) { events.push({ level: 'sent', type, ...fields }); },
            skipped(type, fields) { events.push({ level: 'skipped', type, ...fields }); },
            error(type, fields) { events.push({ level: 'error', type, ...fields }); }
        };
        const job = {
            id: 'report',
            recipient: '380661234567',
            message: 'Private message body',
            files: [{ path: 'documents/report.pdf', caption: 'Private caption' }]
        };

        await runJob({}, job, stateStore, 'report:2026-07-13', {
            sendText: async () => {},
            sendFile: async () => 'documents/report.pdf'
        }, activity);

        assert.deepEqual(events.map((event) => event.type), [
            'job.started',
            'job.message.sent',
            'job.file.sent',
            'job.completed'
        ]);
        const serialized = JSON.stringify(events);
        assert.equal(serialized.includes('380661234567'), false);
        assert.equal(serialized.includes('Private message body'), false);
        assert.equal(serialized.includes('Private caption'), false);
        assert.equal(serialized.includes('report.pdf'), true);
    });
});

test('disabled jobs are not registered', () => {
    const tasks = registerJobs({}, {
        timezone: 'Europe/Kyiv',
        jobs: [
            { id: 'enabled', enabled: true, schedule: '0 8 * * *', recipient: '380660000000', message: 'One', files: [] },
            { id: 'disabled', enabled: false, schedule: '0 9 * * *', recipient: '380660000000', message: 'Two', files: [] }
        ]
    }, { isComplete: () => false });

    try {
        assert.equal(tasks.length, 1);
        assert.equal(tasks[0].jobId, 'enabled');
    } finally {
        for (const { task } of tasks) task.destroy();
    }
});

test('scheduled run sends a completion notification after state is marked complete', async () => {
    await withState(async (stateStore) => {
        const calls = [];
        const key = 'report:2026-07-13';
        const job = {
            id: 'report', recipient: '380660000000', message: 'Report', files: []
        };
        const notifications = {
            async notify(type, context) {
                calls.push([type, stateStore.isComplete(key), context.idempotencyKey, context.sentItems]);
            }
        };

        await runJob({}, job, stateStore, key, {
            sendText: async () => {}
        }, null, notifications);

        assert.deepEqual(calls, [['job.completed', true, key, 1]]);
    });
});

test('partial scheduled failures notify with persisted progress', async () => {
    await withState(async (stateStore) => {
        const calls = [];
        const notifications = {
            apply() {},
            async notify(type, context) {
                calls.push([type, context.sentItems, context.idempotencyKey]);
            }
        };
        const job = {
            id: 'report', enabled: true, schedule: '* * * * *', recipient: '380660000000',
            message: 'Report', files: [{ path: 'documents/report.pdf', caption: '' }]
        };
        const tasks = registerJobs({}, {
            timezone: 'Europe/Kyiv', notifications: {}, jobs: [job]
        }, stateStore, null, notifications);

        try {
            const legacyKey = `report:${dateKey(new Date(), 'Europe/Kyiv')}`;
            stateStore.markMessageSent(legacyKey, new Date().toISOString());
            await tasks[0].task.execute();
            assert.equal(calls.length, 1);
            assert.deepEqual(calls[0].slice(0, 2), ['job.partial', 1]);
            assert.match(calls[0][2], /^report:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
        } finally {
            for (const { task } of tasks) task.destroy();
        }
    });
});


test('scheduled failures retry silently and recover without resending completed items', async () => {
    await withState(async (stateStore) => {
        let sendCalls = 0;
        const notifications = [];
        const client = {
            async sendMessage() {
                sendCalls += 1;
                if (sendCalls < 3) throw new Error('temporary outage');
            }
        };
        const notificationManager = {
            apply() {},
            async notify(type, context) {
                notifications.push([type, context.retryAttempt || 0, context.maxRetries || 0]);
            }
        };
        const manager = new SchedulerManager(client, stateStore, null, notificationManager);
        const job = {
            id: 'report', enabled: true, schedule: '0 8 * * *', recipient: '380660000000',
            retry: { attempts: 2, delayMinutes: 10 }, message: 'Report', files: []
        };
        const key = 'report:2026-07-13';

        assert.equal((await manager.executeScheduled(job, key, 0)).status, 'retrying');
        assert.equal((await manager.executeScheduled(job, key, 1)).status, 'retrying');
        assert.equal((await manager.executeScheduled(job, key, 2)).status, 'sent');

        assert.equal(sendCalls, 3);
        assert.equal(stateStore.isComplete(key), true);
        assert.deepEqual(notifications, [
            ['job.retry.scheduled', 1, 2],
            ['job.retry.scheduled', 2, 2],
            ['job.recovered', 2, 2]
        ]);
        manager.stop();
    });
});

test('retry exhaustion sends one initial retry notice and one exhausted notice', async () => {
    await withState(async (stateStore) => {
        const notifications = [];
        const client = { async sendMessage() { throw new Error('offline'); } };
        const manager = new SchedulerManager(client, stateStore, null, {
            apply() {},
            async notify(type, context) {
                notifications.push([type, context.retryAttempt || 0]);
            }
        });
        const job = {
            id: 'report', enabled: true, schedule: '0 8 * * *', recipient: '380660000000',
            retry: { attempts: 2, delayMinutes: 10 }, message: 'Report', files: []
        };
        const key = 'report:2026-07-13';

        await manager.executeScheduled(job, key, 0);
        await manager.executeScheduled(job, key, 1);
        const result = await manager.executeScheduled(job, key, 2);

        assert.equal(result.status, 'failed');
        assert.deepEqual(notifications, [
            ['job.retry.scheduled', 1],
            ['job.retry.scheduled', 2],
            ['job.retry.exhausted', 2]
        ]);
        assert.deepEqual(stateStore.listPendingRetries(), []);
        manager.stop();
    });
});

test('pending retry state is resumed when scheduler configuration is applied', async () => {
    await withState(async (stateStore) => {
        const key = 'report:2026-07-13';
        stateStore.markRetryScheduled(key, 2, '2026-07-13T05:10:00.000Z');
        const timers = [];
        const manager = new SchedulerManager({}, stateStore, null, { apply() {} }, {
            now: () => new Date('2026-07-13T05:00:00.000Z'),
            setTimeout(callback, delay) {
                const timer = { callback, delay, unref() {} };
                timers.push(timer);
                return timer;
            },
            clearTimeout() {}
        });
        const config = {
            timezone: 'Europe/Kyiv', notifications: {}, jobs: [{
                id: 'report', enabled: true, schedule: '0 8 * * *', recipient: '380660000000',
                retry: { attempts: 5, delayMinutes: 10 }, message: 'Report', files: []
            }]
        };

        manager.apply(config);
        assert.equal(timers.length, 1);
        assert.equal(timers[0].delay, 10 * 60 * 1000);
        manager.stop();
    });
});


test('occurrence keys distinguish scheduled runs on the same day', () => {
    assert.equal(
        occurrenceKey('report', new Date('2026-07-13T05:00:00.000Z'), 'Europe/Kyiv'),
        'report:2026-07-13T08:00'
    );
    assert.equal(
        occurrenceKey('report', new Date('2026-07-13T17:00:00.000Z'), 'Europe/Kyiv'),
        'report:2026-07-13T20:00'
    );
});

test('retry continues with the original job snapshot after configuration is edited', async () => {
    await withState(async (stateStore) => {
        const calls = [];
        let attempts = 0;
        const client = {
            async sendMessage(chatId, message) {
                attempts += 1;
                calls.push([chatId, message]);
                if (attempts === 1) throw new Error('temporary outage');
                return {};
            }
        };
        const manager = new SchedulerManager(client, stateStore);
        const originalJob = {
            id: 'report', enabled: true, schedule: '0 8 * * *', recipient: '380660000001',
            retry: { attempts: 1, delayMinutes: 10 }, message: 'Original message', files: []
        };
        const editedJob = {
            ...originalJob,
            recipient: '380660000002',
            message: 'Edited message'
        };
        const key = 'report:2026-07-13T08:00';

        assert.equal((await manager.executeScheduled(originalJob, key, 0)).status, 'retrying');
        assert.equal((await manager.executeScheduled(editedJob, key, 1)).status, 'sent');

        assert.deepEqual(calls, [
            ['380660000001@c.us', 'Original message'],
            ['380660000001@c.us', 'Original message']
        ]);
        assert.deepEqual(stateStore.getRunSnapshot(key), {
            id: 'report',
            recipient: '380660000001',
            message: 'Original message',
            files: [],
            retry: { attempts: 1, delayMinutes: 10 }
        });
        manager.stop();
    });
});

test('completed same-day occurrences execute independently', async () => {
    await withState(async (stateStore) => {
        const calls = [];
        const client = { async sendMessage(chatId, message) { calls.push([chatId, message]); return {}; } };
        const manager = new SchedulerManager(client, stateStore);
        const job = {
            id: 'report', enabled: true, schedule: '0 8,20 * * *', recipient: '380660000000',
            retry: { attempts: 0, delayMinutes: 10 }, message: 'Report', files: []
        };

        assert.equal((await manager.executeScheduled(job, 'report:2026-07-13T08:00', 0)).status, 'sent');
        assert.equal((await manager.executeScheduled(job, 'report:2026-07-13T20:00', 0)).status, 'sent');
        assert.equal(calls.length, 2);
        assert.equal(stateStore.isComplete('report:2026-07-13T08:00'), true);
        assert.equal(stateStore.isComplete('report:2026-07-13T20:00'), true);
        manager.stop();
    });
});

test('a new occurrence is blocked while an earlier occurrence is still retrying', async () => {
    await withState(async (stateStore) => {
        const events = [];
        const activity = {
            info() {}, sent() {}, error() {},
            skipped(type, fields) { events.push([type, fields.jobId]); }
        };
        const manager = new SchedulerManager({}, stateStore, activity, { apply() {} });
        const job = {
            id: 'report', enabled: true, schedule: '0 8,20 * * *', recipient: '380660000000',
            retry: { attempts: 2, delayMinutes: 10 }, message: 'Report', files: []
        };
        const earlierKey = 'report:2026-07-13T08:00';
        stateStore.captureRunSnapshot(earlierKey, job);
        stateStore.markRetryScheduled(earlierKey, 1, '2026-07-13T05:10:00.000Z');

        const result = await manager.executeScheduled(job, 'report:2026-07-13T20:00', 0);

        assert.equal(result.status, 'blocked');
        assert.equal(result.previousRunKey, earlierKey);
        assert.deepEqual(events, [['job.occurrence.blocked', 'report']]);
        assert.equal(stateStore.has('report:2026-07-13T20:00'), false);
        manager.stop();
    });
});

test('job-level locking prevents a scheduled run from overlapping a manual run', async () => {
    await withState(async (stateStore) => {
        const manager = new SchedulerManager({}, stateStore, null, { apply() {} });
        const job = {
            id: 'report', enabled: true, schedule: '* * * * *', recipient: '380660000000',
            retry: { attempts: 0, delayMinutes: 10 }, message: 'Report', files: []
        };

        assert.equal(manager.beginManualRun('report'), true);
        const result = await manager.executeScheduled(job, 'report:2026-07-13T08:00', 0);
        assert.equal(result.status, 'overlap');
        manager.endManualRun('report');
        assert.equal(manager.isJobActive('report'), false);
        manager.stop();
    });
});


test('latest cron occurrence is resolved in the configured timezone', () => {
    const occurrence = latestCronOccurrence(
        '0 8 * * 1',
        'Europe/Kyiv',
        new Date('2026-07-13T06:00:00.000Z'),
        24
    );

    assert.equal(occurrence.toISOString(), '2026-07-13T05:00:00.000Z');
    assert.equal(latestCronOccurrence(
        '0 8 * * 1',
        'Europe/Kyiv',
        new Date('2026-07-14T06:00:00.000Z'),
        12
    ), null);
});

test('missed run catch-up window is validated and can be disabled', () => {
    assert.equal(parseMissedRunCatchUpHours(undefined), 24);
    assert.equal(parseMissedRunCatchUpHours('0'), 0);
    assert.equal(parseMissedRunCatchUpHours('48'), 48);
    assert.throws(() => parseMissedRunCatchUpHours('-1'), /between 0 and 720/);
    assert.throws(() => parseMissedRunCatchUpHours('721'), /between 0 and 720/);
});

test('startup catch-up sends the latest missed occurrence only once', async () => {
    await withState(async (stateStore) => {
        const sent = [];
        const notificationEvents = [];
        const activityEvents = [];
        const client = {
            async sendMessage(chatId, message) {
                sent.push([chatId, message]);
                return {};
            }
        };
        const manager = new SchedulerManager(client, stateStore, {
            info(type, fields) { activityEvents.push([type, fields.jobId]); },
            sent() {}, error() {}, skipped() {}
        }, {
            apply() {},
            async notify(type, context) { notificationEvents.push([type, context.idempotencyKey]); }
        }, {
            now: () => new Date('2026-07-13T06:00:00.000Z'),
            catchUpHours: 24
        });
        const config = {
            timezone: 'Europe/Kyiv', notifications: {}, jobs: [{
                id: 'report', enabled: true, schedule: '0 8 * * 1', recipient: '380660000000',
                retry: { attempts: 0, delayMinutes: 10 }, message: 'Report', files: []
            }]
        };

        manager.apply(config);
        const first = await manager.resumeMissedRuns();
        const second = await manager.resumeMissedRuns();

        assert.equal(first.length, 1);
        assert.equal(first[0].key, 'report:2026-07-13T08:00');
        assert.deepEqual(second, []);
        assert.deepEqual(sent, [['380660000000@c.us', 'Report']]);
        assert.deepEqual(activityEvents.filter(([type]) => type === 'job.catchup.started'), [
            ['job.catchup.started', 'report']
        ]);
        assert.deepEqual(notificationEvents, [
            ['job.catchup.started', 'report:2026-07-13T08:00'],
            ['job.completed', 'report:2026-07-13T08:00']
        ]);
        manager.stop();
    });
});
