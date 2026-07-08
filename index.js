require('dotenv').config();

const { ActivityLog } = require('./src/activity');
const { loadConfig } = require('./src/config');
const { SchedulerManager } = require('./src/scheduler');
const { StateStore } = require('./src/state');
const { createWhatsAppClient } = require('./src/whatsapp');
const { createWebServer } = require('./src/web/server');

async function main() {
    const configPath = process.env.WA_SCHEDULE_CONFIG || 'schedule.json';
    const config = loadConfig(configPath);
    const activity = new ActivityLog(process.env.WA_ACTIVITY_FILE);
    const stateStore = new StateStore(process.env.WA_STATE_FILE);
    const client = createWhatsAppClient(activity);
    const schedulerManager = new SchedulerManager(client, stateStore, activity);
    const status = { whatsapp: 'connecting' };
    const host = process.env.WA_UI_HOST || '127.0.0.1';
    const port = Number(process.env.WA_UI_PORT || 3000);

    client.on('authenticated', () => {
        status.whatsapp = 'authenticated';
    });

    client.on('disconnected', () => {
        status.whatsapp = 'disconnected';
    });

    client.once('ready', () => {
        status.whatsapp = 'ready';
        activity.info('whatsapp.ready', { message: 'WhatsApp ready' });
        schedulerManager.apply(config);
    });

    const app = createWebServer({
        client,
        stateStore,
        schedulerManager,
        configPath,
        status,
        activity
    });

    app.listen(port, host, () => {
        activity.info('ui.ready', { message: `UI available at http://${host}:${port}` });
    });

    await client.initialize();
}

main().catch((error) => {
    console.error('wa-scheduler failed to start:', error);
    process.exitCode = 1;
});
