const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { StateStore } = require('../src/state');

test('sent state is persisted and reloaded', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-scheduler-state-'));
    const statePath = path.join(directory, 'state.json');

    try {
        const store = new StateStore(statePath);
        store.markSent('monday-report:2026-07-13', '2026-07-13T05:00:03.000Z');

        const reloaded = new StateStore(statePath);
        assert.equal(reloaded.has('monday-report:2026-07-13'), true);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
