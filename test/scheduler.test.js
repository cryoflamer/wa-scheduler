const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { dateKey, runJob } = require('../src/scheduler');
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
