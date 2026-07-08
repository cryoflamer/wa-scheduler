function closeHttpServer(server, forceCloseDelayMs = 1000) {
    if (!server?.close) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
        };

        server.close(finish);
        server.closeIdleConnections?.();

        timer = setTimeout(() => {
            server.closeAllConnections?.();
        }, forceCloseDelayMs);
        timer.unref?.();
    });
}

async function shutdownRuntime({ schedulerManager, app, server, client, notificationManager }) {
    schedulerManager?.stop?.();
    notificationManager?.stop?.();
    app?.closeStreams?.();
    await closeHttpServer(server);
    await client?.destroy?.();
}

function withTimeout(promise, timeoutMs, message = 'Shutdown timed out') {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createShutdownHandler(options) {
    const {
        schedulerManager,
        app,
        server,
        client,
        notificationManager,
        activity,
        timeoutMs = 15000,
        exit = (code) => process.exit(code)
    } = options;
    let shutdownPromise = null;

    return function shutdown(signal) {
        if (shutdownPromise) {
            return shutdownPromise;
        }

        shutdownPromise = (async () => {
            activity?.info('runtime.stopping', { message: `Stopping after ${signal}` });
            let exitCode = 0;

            try {
                await withTimeout(
                    shutdownRuntime({ schedulerManager, app, server, client, notificationManager }),
                    timeoutMs
                );
                activity?.info('runtime.stopped', { message: 'wa-scheduler stopped' });
            } catch (error) {
                exitCode = 1;
                if (activity) activity.error('runtime.shutdown.failed', { error });
                else console.error('wa-scheduler shutdown failed:', error);
            }

            exit(exitCode);
            return exitCode;
        })();

        return shutdownPromise;
    };
}

module.exports = {
    closeHttpServer,
    createShutdownHandler,
    shutdownRuntime,
    withTimeout
};
