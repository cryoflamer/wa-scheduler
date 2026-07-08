const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SERVICE_NAME = 'wa-scheduler.service';

function servicePath(home = os.homedir()) {
    return path.join(home, '.config', 'systemd', 'user', SERVICE_NAME);
}

function buildUnit({ projectRoot = path.resolve('.'), nodePath = process.execPath } = {}) {
    return `[Unit]\nDescription=wa-scheduler WhatsApp scheduler\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${projectRoot}\nExecStart=${nodePath} ${path.join(projectRoot, 'index.js')}\nRestart=on-failure\nRestartSec=5\nKillSignal=SIGTERM\nTimeoutStopSec=20\n\n[Install]\nWantedBy=default.target\n`;
}

function runSystemctl(args, options = {}) {
    const { acceptedStatuses = [0], ...spawnOptions } = options;
    const result = spawnSync('systemctl', ['--user', ...args], {
        encoding: 'utf8',
        ...spawnOptions
    });
    if (result.error) throw new Error(`systemctl is unavailable: ${result.error.message}`);
    if (!acceptedStatuses.includes(result.status)) {
        throw new Error((result.stderr || result.stdout || 'systemctl failed').trim());
    }
    return (result.stdout || result.stderr || '').trim();
}

function installService(options = {}) {
    const target = options.target || servicePath(options.home);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buildUnit(options));
    (options.runSystemctl || runSystemctl)(['daemon-reload']);
    (options.runSystemctl || runSystemctl)(['enable', '--now', SERVICE_NAME]);
    return target;
}

function removeService(options = {}) {
    const target = options.target || servicePath(options.home);
    const run = options.runSystemctl || runSystemctl;
    try { run(['disable', '--now', SERVICE_NAME]); } catch (_) {}
    fs.rmSync(target, { force: true });
    run(['daemon-reload']);
    return target;
}

function serviceStatus(options = {}) {
    return (options.runSystemctl || runSystemctl)(
        ['status', SERVICE_NAME, '--no-pager'],
        { acceptedStatuses: [0, 3] }
    );
}

module.exports = { SERVICE_NAME, buildUnit, installService, removeService, servicePath, serviceStatus };
