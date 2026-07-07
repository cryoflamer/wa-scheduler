const cron = require('node-cron');
const { sendDocument } = require('./whatsapp');

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

function registerJobs(client, config, stateStore) {
    const tasks = [];

    for (const job of config.jobs) {
        if (!cron.validate(job.schedule)) {
            throw new Error(`Invalid cron schedule for job ${job.id}: ${job.schedule}`);
        }

        const task = cron.schedule(
            job.schedule,
            async () => {
                const now = new Date();
                const key = `${job.id}:${dateKey(now, config.timezone)}`;

                if (stateStore.has(key)) {
                    console.log(`Job ${job.id} already sent for this date; skipping`);
                    return;
                }

                try {
                    const filePath = await sendDocument(client, job);
                    const sentAt = new Date().toISOString();

                    stateStore.markSent(key, sentAt);
                    console.log(`Job ${job.id} sent: ${filePath}`);
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

module.exports = {
    dateKey,
    registerJobs
};
