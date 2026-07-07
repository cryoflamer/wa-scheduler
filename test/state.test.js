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
