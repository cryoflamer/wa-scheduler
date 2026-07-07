const cron = require('node-cron');
const { sendDocument, sendTextMessage } = require('./whatsapp');

function dateKey(date, timezone) {
    const parts = new Intl.DateTimeFormat('en', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));

    return `${values.year}-${values.month}-${values.day}`;
}

async function runJob(client, job, stateStore, key, senders = {}) {
    const sendText = senders.sendText || sendTextMessage;
    const sendFile = senders.sendFile || sendDocument;

    if (stateStore.isComplete(key)) {
        console.log(`Job ${job.id} already sent for this date; skipping`);
        return { status: 'skipped' };
    }

    if (job.message && !stateStore.isMessageSent(key)) {
        await sendText(client, job.recipient, job.message);
        stateStore.markMessageSent(key, new Date().toISOString());
        console.log(`Job ${job.id} message sent`);
    }

    for (const file of job.files) {
        if (stateStore.isFileSent(key, file.path)) {
            continue;
        }

        const filePath = await sendFile(client, job.recipient, file);
        stateStore.markFileSent(key, file.path, new Date().toISOString());
        console.log(`Job ${job.id} file sent: ${filePath}`);
    }

    stateStore.markComplete(key, new Date().toISOString());
    console.log(`Job ${job.id} completed`);

    return { status: 'sent' };
}

function registerJobs(client, config, stateStore) {
    for (const job of config.jobs) {
        if (!cron.validate(job.schedule)) {
            throw new Error(`Invalid cron schedule for job ${job.id}: ${job.schedule}`);
        }
    }

    const tasks = [];

    for (const job of config.jobs) {
        const task = cron.schedule(
            job.schedule,
            async () => {
                const now = new Date();
                const key = `${job.id}:${dateKey(now, config.timezone)}`;

                try {
                    await runJob(client, job, stateStore, key);
                } catch (error) {
                    console.error(`Job ${job.id} failed:`, error);
                }
            },
            {
                timezone: config.timezone,
                noOverlap: true
            }
        );

        tasks.push(task);
        console.log(`Job ${job.id} scheduled: ${job.schedule} (${config.timezone})`);
    }

    return tasks;
}

class SchedulerManager {
    constructor(client, stateStore) {
        this.client = client;
        this.stateStore = stateStore;
        this.tasks = [];
        this.config = null;
    }

    apply(config) {
        const nextTasks = registerJobs(this.client, config, this.stateStore);
        this.stop();
        this.tasks = nextTasks;
        this.config = config;
    }

    stop() {
        for (const task of this.tasks) {
            task.destroy();
        }
        this.tasks = [];
    }
}

module.exports = {
    dateKey,
    registerJobs,
    runJob,
    SchedulerManager
};
