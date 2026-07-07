require('dotenv').config();

const { loadConfig } = require('./src/config');
const { registerJobs } = require('./src/scheduler');
const { StateStore } = require('./src/state');
const { createWhatsAppClient } = require('./src/whatsapp');

async function main() {
    const config = loadConfig(process.env.WA_SCHEDULE_CONFIG);
    const stateStore = new StateStore(process.env.WA_STATE_FILE);
    const client = createWhatsAppClient();

    client.once('ready', () => {
        console.log('WhatsApp ready');
        registerJobs(client, config, stateStore);
    });

    await client.initialize();
}

main().catch((error) => {
    console.error('wa-scheduler failed to start:', error);
    process.exitCode = 1;
});
