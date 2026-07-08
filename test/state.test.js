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
            timestamp: '2026-07-13T05:00:02.000Z',
            retry: null
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


test('retry state is persisted and exposed as a pending scheduled run', () => {
    withStore((store) => {
        const key = 'report:2026-07-13';
        const job = { id: 'report', message: 'Message', files: [] };
        store.markRunStarted(key, '2026-07-13T05:00:00.000Z');
        store.markRunFailed(key, '2026-07-13T05:00:01.000Z');
        store.markRetryScheduled(key, 2, '2026-07-13T05:10:01.000Z');

        assert.deepEqual(store.listPendingRetries(), [{
            key,
            jobId: 'report',
            retryAttempt: 2,
            nextRetryAt: '2026-07-13T05:10:01.000Z'
        }]);
        assert.deepEqual(store.getLatestScheduledRun(job).retry, {
            attempt: 2,
            nextRetryAt: '2026-07-13T05:10:01.000Z'
        });
    });
});


test('legacy daily scheduled state migrates to the first occurrence key', () => {
    withStore((store) => {
        const legacyKey = 'report:2026-07-13';
        const occurrence = 'report:2026-07-13T08:00';
        store.markSent(legacyKey, '2026-07-13T05:00:00.000Z');

        assert.equal(store.migrateLegacyScheduledRun(occurrence, 'report'), true);
        assert.equal(store.has(legacyKey), false);
        assert.equal(store.isComplete(occurrence), true);
        assert.equal(store.migrateLegacyScheduledRun('report:2026-07-13T20:00', 'report'), false);
    });
});

test('scheduled run snapshots preserve dispatch payload and fingerprint', () => {
    withStore((store) => {
        const key = 'report:2026-07-13T08:00';
        const original = {
            id: 'report', recipient: '380660000001', message: 'Original',
            files: [{ path: 'documents/report.pdf', caption: 'Appendix' }],
            retry: { attempts: 3, delayMinutes: 10 }
        };
        const edited = { ...original, recipient: '380660000002', message: 'Edited' };

        assert.deepEqual(store.captureRunSnapshot(key, original), original);
        assert.deepEqual(store.captureRunSnapshot(key, edited), original);
        assert.deepEqual(store.getRunSnapshot(key), original);
        assert.match(store.state[key].fingerprint, /^[0-9a-f]{64}$/);
        assert.equal(store.state[key].jobId, 'report');
    });
});

test('state retention prunes old resolved records but keeps unresolved work and pending notifications', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-state-retention-'));
    const statePath = path.join(directory, 'state.json');
    const old = '2026-01-01T00:00:00.000Z';
    const now = () => new Date('2026-07-08T00:00:00.000Z');

    try {
        const initial = new StateStore(statePath, { retentionDays: 90, now });
        initial.markComplete('old-complete:2026-01-01T08:00', old);
        initial.markRunFailed('old-failed:2026-01-01T08:00', old);
        initial.markRunStarted('active:2026-01-01T08:00', old);
        initial.markRetryScheduled('retrying:2026-01-01T08:00', 1, '2026-07-09T00:00:00.000Z');
        initial.markComplete('pending-notification:2026-01-01T08:00', old);
        initial.queueNotification(
            'pending-notification:2026-01-01T08:00',
            'job.completed',
            'ntfy',
            { notification: { title: 'title', message: 'message' }, jobId: 'pending-notification' },
            old
        );

        const reloaded = new StateStore(statePath, { retentionDays: 90, now });
        assert.equal(reloaded.has('old-complete:2026-01-01T08:00'), false);
        assert.equal(reloaded.has('old-failed:2026-01-01T08:00'), false);
        assert.equal(reloaded.has('active:2026-01-01T08:00'), true);
        assert.equal(reloaded.has('retrying:2026-01-01T08:00'), true);
        assert.equal(reloaded.has('pending-notification:2026-01-01T08:00'), true);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('state retention defaults to 90 days and rejects invalid values', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-state-retention-config-'));
    try {
        const store = new StateStore(path.join(directory, 'state.json'), { now: () => new Date() });
        assert.equal(store.retentionDays, 90);
        assert.throws(
            () => new StateStore(path.join(directory, 'invalid.json'), { retentionDays: 0 }),
            /WA_STATE_RETENTION_DAYS must be an integer between 1 and 3650/
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
