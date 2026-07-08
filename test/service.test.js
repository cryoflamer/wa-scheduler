const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildUnit, installService, removeService } = require('../src/service');

test('systemd unit uses the active Node executable and project root', () => {
    const unit = buildUnit({ projectRoot: '/home/alex/wa-scheduler', nodePath: '/home/alex/.nvm/node' });
    assert.match(unit, /WorkingDirectory=\/home\/alex\/wa-scheduler/);
    assert.match(unit, /ExecStart=\/home\/alex\/\.nvm\/node \/home\/alex\/wa-scheduler\/index\.js/);
    assert.match(unit, /Restart=on-failure/);
});

test('service install and remove manage the generated user unit', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-scheduler-service-'));
    const target = path.join(directory, 'wa-scheduler.service');
    const calls = [];
    const runSystemctl = (args) => { calls.push(args); return ''; };

    try {
        installService({ target, projectRoot: '/project', nodePath: '/node', runSystemctl });
        assert.equal(fs.existsSync(target), true);
        assert.deepEqual(calls, [
            ['daemon-reload'],
            ['enable', '--now', 'wa-scheduler.service']
        ]);

        calls.length = 0;
        removeService({ target, runSystemctl });
        assert.equal(fs.existsSync(target), false);
        assert.deepEqual(calls, [
            ['disable', '--now', 'wa-scheduler.service'],
            ['daemon-reload']
        ]);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
