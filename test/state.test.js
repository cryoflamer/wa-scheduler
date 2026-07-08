const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { StateStore } = require('../src/state');

function withStore(callback) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-scheduler-state-'));
    const statePath = path.join(directory, 'state.json');

    try {
        return callback(new StateStore(statePath), statePath);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test('item state is persisted and reloaded', () => {
    withStore((store, statePath) => {
        const key = 'monday-report:2026-07-13';
        store.markMessageSent(key, '2026-07-13T05:00:01.000Z');
        store.markFileSent(key, 'documents/report.pdf', '2026-07-13T05:00:02.000Z');

        const reloaded = new StateStore(statePath);
        assert.equal(reloaded.isMessageSent(key), true);
        assert.equal(reloaded.isFileSent(key, 'documents/report.pdf'), true);
        assert.equal(reloaded.isComplete(key), false);
    });
});

test('completed state is persisted and reloaded', () => {
    withStore((store, statePath) => {
        const key = 'monday-report:2026-07-13';
        store.markComplete(key, '2026-07-13T05:00:03.000Z');

        const reloaded = new StateStore(statePath);
        assert.equal(reloaded.has(key), true);
        assert.equal(reloaded.isComplete(key), true);
    });
});

test('latest scheduled run reports completed and partial job status', () => {
    withStore((store) => {
        const job = {
            id: 'report',
            message: 'Message',
            files: [{ path: 'documents/report.pdf' }, { path: 'documents/table.xlsx' }]
        };
        store.markRunStarted('report:2026-07-12', '2026-07-12T05:00:00.000Z');
        store.markComplete('report:2026-07-12', '2026-07-12T05:00:03.000Z');
        store.markRunStarted('report:2026-07-13', '2026-07-13T05:00:00.000Z');
        store.markMessageSent('report:2026-07-13', '2026-07-13T05:00:01.000Z');
        store.markRunFailed('report:2026-07-13', '2026-07-13T05:00:02.000Z');

        assert.deepEqual(store.getLatestScheduledRun(job), {
            key: 'report:2026-07-13',
            date: '2026-07-13',
            status: 'partial',
            sentItems: 1,
            totalItems: 3,
            timestamp: '2026-07-13T05:00:02.000Z'
        });
    });
});

test('manual state is excluded from latest scheduled run', () => {
    withStore((store) => {
        const job = { id: 'report', message: 'Message', files: [] };
        store.markComplete('manual:report:123', '2026-07-14T05:00:00.000Z');
        assert.equal(store.getLatestScheduledRun(job), null);
    });
});

test('notification delivery state is persisted per event and provider', () => {
    withStore((store) => {
        const key = 'report:2026-07-13';
        store.markNotificationSent(key, 'job.completed', 'whatsapp', '2026-07-13T05:00:03.000Z');
        assert.equal(store.isNotificationSent(key, 'job.completed', 'whatsapp'), true);
        assert.equal(store.isNotificationSent(key, 'job.completed', 'ntfy'), false);
    });
});

test('run progress counts sent messages and files', () => {
    withStore((store) => {
        const key = 'report:2026-07-13';
        const job = { message: 'Message', files: [{ path: 'one.pdf' }, { path: 'two.pdf' }] };
        store.markMessageSent(key, '2026-07-13T05:00:01.000Z');
        store.markFileSent(key, 'one.pdf', '2026-07-13T05:00:02.000Z');
        assert.deepEqual(store.getRunProgress(key, job), { sentItems: 2, totalItems: 3 });
    });
});

test('run details identify sent and pending message and file items', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-state-details-'));
    const stateStore = new StateStore(path.join(directory, 'state.json'));
    const key = 'report:2026-07-08';
    const job = {
        message: 'Report',
        files: [
            { path: 'documents/report.pdf' },
            { path: 'documents/table.xlsx' }
        ]
    };

    try {
        stateStore.markMessageSent(key, '2026-07-08T05:00:00.000Z');
        stateStore.markFileSent(key, 'documents/report.pdf', '2026-07-08T05:00:01.000Z');

        assert.deepEqual(stateStore.getRunDetails(key, job), {
            sentItems: 2,
            totalItems: 3,
            sent: [
                { type: 'message', label: 'message', sent: true },
                { type: 'file', label: 'report.pdf', sent: true }
            ],
            pending: [
                { type: 'file', label: 'table.xlsx', sent: false }
            ]
        });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
