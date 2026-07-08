const assert = require('node:assert/strict');
const test = require('node:test');
const { createShutdownHandler, shutdownRuntime } = require('../src/runtime');

test('runtime shutdown stops scheduler and streams before closing HTTP and WhatsApp', async () => {
    const calls = [];
    const schedulerManager = { stop: () => calls.push('scheduler.stop') };
    const notificationManager = { stop: () => calls.push('notifications.stop') };
    const app = { closeStreams: () => calls.push('app.closeStreams') };
    const server = {
        close: (callback) => {
            calls.push('server.close');
            callback();
        },
        closeIdleConnections: () => calls.push('server.closeIdleConnections'),
        closeAllConnections: () => calls.push('server.closeAllConnections')
    };
    const client = { destroy: async () => calls.push('client.destroy') };

    await shutdownRuntime({ schedulerManager, app, server, client, notificationManager });

    assert.deepEqual(calls.slice(0, 6), [
        'scheduler.stop',
        'notifications.stop',
        'app.closeStreams',
        'server.close',
        'server.closeIdleConnections',
        'client.destroy'
    ]);
});

test('shutdown handler is idempotent and exits cleanly after graceful shutdown', async () => {
    const calls = [];
    const events = [];
    const shutdown = createShutdownHandler({
        schedulerManager: { stop: () => calls.push('scheduler.stop') },
        app: { closeStreams: () => calls.push('app.closeStreams') },
        server: { close: (callback) => callback() },
        client: { destroy: async () => calls.push('client.destroy') },
        activity: {
            info: (type) => events.push(type),
            error: (type) => events.push(type)
        },
        exit: (code) => calls.push(`exit:${code}`)
    });

    const first = shutdown('SIGTERM');
    const second = shutdown('SIGINT');
    assert.strictEqual(first, second);
    assert.equal(await first, 0);

    assert.deepEqual(events, ['runtime.stopping', 'runtime.stopped']);
    assert.deepEqual(calls, [
        'scheduler.stop',
        'app.closeStreams',
        'client.destroy',
        'exit:0'
    ]);
});

test('shutdown handler reports timeout failures and exits non-zero', async () => {
    const events = [];
    const exits = [];
    const shutdown = createShutdownHandler({
        schedulerManager: { stop: () => {} },
        app: { closeStreams: () => {} },
        server: { close: () => {} },
        client: { destroy: async () => {} },
        activity: {
            info: (type) => events.push(type),
            error: (type) => events.push(type)
        },
        timeoutMs: 10,
        exit: (code) => exits.push(code)
    });

    assert.equal(await shutdown('SIGTERM'), 1);
    assert.deepEqual(events, ['runtime.stopping', 'runtime.shutdown.failed']);
    assert.deepEqual(exits, [1]);
});
