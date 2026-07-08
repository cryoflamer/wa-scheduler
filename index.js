require('dotenv').config();

const { ActivityLog } = require('./src/activity');
const { ensureLocalConfig, loadConfig } = require('./src/config');
const { SchedulerManager } = require('./src/scheduler');
const { NotificationManager } = require('./src/notifications/manager');
const { StateStore } = require('./src/state');
const { createShutdownHandler } = require('./src/runtime');
const { createWhatsAppClient } = require('./src/whatsapp');
const { createWebServer } = require('./src/web/server');

async function main() {
    const configPath = process.env.WA_SCHEDULE_CONFIG || 'schedule.json';
    const examplePath = process.env.WA_SCHEDULE_EXAMPLE || 'schedule.example.json';
    const activity = new ActivityLog(process.env.WA_ACTIVITY_FILE);
    const scheduleCreated = ensureLocalConfig(configPath, examplePath);
    const config = loadConfig(configPath);

    if (scheduleCreated) {
        activity.info('config.schedule.created', {
            message: `Local schedule created from ${examplePath}`
        });
    }
    const stateStore = new StateStore(process.env.WA_STATE_FILE);
    const client = createWhatsAppClient(activity);
    const notificationManager = new NotificationManager({ client, stateStore, activity });
    notificationManager.apply(config.notifications);
    const schedulerManager = new SchedulerManager(client, stateStore, activity, notificationManager);
    const status = { whatsapp: 'connecting', startedAt: new Date().toISOString() };
    const host = process.env.WA_UI_HOST || '127.0.0.1';
    const port = Number(process.env.WA_UI_PORT || 3000);

    client.on('authenticated', () => {
        status.whatsapp = 'authenticated';
    });

    let disconnectSequence = 0;
    client.on('disconnected', () => {
        status.whatsapp = 'disconnected';
        disconnectSequence += 1;
        void notificationManager.notify('whatsapp.disconnected', {
            idempotencyKey: `system:whatsapp.disconnected:${disconnectSequence}`
        });
    });

    client.once('ready', () => {
        status.whatsapp = 'ready';
        activity.info('whatsapp.ready', { message: 'WhatsApp ready' });
        schedulerManager.apply(config, { catchUpMissed: true });
        notificationManager.start();
    });

    const app = createWebServer({
        client,
        stateStore,
        schedulerManager,
        configPath,
        status,
        activity,
        notificationManager
    });

    const server = app.listen(port, host, () => {
        activity.info('ui.ready', { message: `UI available at http://${host}:${port}` });
    });
    const shutdown = createShutdownHandler({
        schedulerManager,
        app,
        server,
        client,
        activity,
        notificationManager
    });

    process.once('SIGTERM', () => {
        void shutdown('SIGTERM');
    });
    process.once('SIGINT', () => {
        void shutdown('SIGINT');
    });

    await client.initialize();
}

main().catch((error) => {
    console.error('wa-scheduler failed to start:', error);
    process.exitCode = 1;
});
