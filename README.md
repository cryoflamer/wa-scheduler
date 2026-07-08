# wa-scheduler

Scheduled WhatsApp message and document sender built on `whatsapp-web.js`.

## Setup

Use Node.js 22 or newer and install dependencies:

```bash
nvm use
npm ci
```

Create the local environment file:

```bash
cp .env.example .env
```

Edit `.env` and set the real WhatsApp recipient numbers. `.env` is ignored by Git, so personal phone numbers stay local.

Place documents under `documents/`. Document contents, scheduler state, WhatsApp authentication data, `.env`, and the local `schedule.json` are ignored by Git.

## Schedule configuration

The repository tracks `schedule.example.json`. On the first start, wa-scheduler copies it to the ignored local `schedule.json`, and the UI edits only that local schedule:

```json
{
  "timezone": "Europe/Kyiv",
  "jobs": [
    {
      "id": "monday-report",
      "schedule": "0 8 * * 1",
      "recipient": "${WA_RECIPIENT_SELF}",
      "retry": {
        "attempts": 5,
        "delayMinutes": 10
      },
      "message": "Доброго ранку. Надсилаю документи за понеділок.",
      "files": [
        "documents/report.pdf",
        {
          "path": "documents/table.xlsx",
          "caption": "Додаток 1"
        }
      ]
    }
  ]
}
```

The matching local `.env` contains the private value:

```dotenv
WA_RECIPIENT_SELF=380XXXXXXXXX
```

`${VARIABLE}` placeholders can be used in string values in the schedule, including messages, file paths, and file captions. Startup fails with a clear error when a referenced environment variable is missing.

Deleting the local `schedule.json` resets the operational schedule on the next start by recreating it from `schedule.example.json`. An empty `jobs` array is valid, so a fresh local schedule can be configured entirely from the dashboard. Set `WA_SCHEDULE_CONFIG` or `WA_SCHEDULE_EXAMPLE` to override either path.

Each job id must be unique. `schedule` uses cron syntax and is evaluated in the configured timezone. A job can contain a `message`, a `files` array, or both. Files can be written as a path string or as an object with `path` and an optional `caption`.

The original single-document form remains supported:

```json
{
  "id": "legacy-report",
  "schedule": "0 8 * * 1",
  "recipient": "${WA_RECIPIENT_SELF}",
  "file": "documents/report.pdf",
  "caption": "Документ"
}
```

`file` and `caption` are normalized to a one-item `files` array. Do not define both `file` and `files` in the same job.

## Run

```bash
npm start
```

On first start, scan the QR code from WhatsApp under **Linked devices**. The client registers configured jobs after WhatsApp becomes ready.

Scheduler progress is recorded in `data/state.json` under a key composed from the job id and the exact scheduled occurrence in the configured timezone, for example `monday-report:2026-07-13T08:00`. Two cron occurrences on the same calendar day therefore have independent state and can both run. Message and file sends are persisted separately. If a multi-item job fails partway through, a later retry skips already recorded items and resumes with the first unsent item. The job is marked complete only after every configured item has been sent.

The first scheduled attempt also stores an immutable snapshot and SHA-256 fingerprint of the resolved recipient, message, files, captions, and retry policy. Pending retries continue from that original snapshot even when the job is edited in the dashboard before the retry fires. A new scheduled occurrence is not started while an earlier occurrence of the same job is still running or waiting for retry, and manual **Send now** is rejected while the same job is already active.

State written by the earlier daily-key scheduler remains compatible: the legacy `job-id:YYYY-MM-DD` record is migrated to the first exact occurrence encountered for that date. A record already marked with `status: "sent"` remains completed and is not resent during that migration.

Alternative paths can be selected with `WA_SCHEDULE_CONFIG`, `WA_STATE_FILE`, and `WA_ACTIVITY_FILE`.

## Test

```bash
npm test
```

## Local web UI

Starting the scheduler also starts a compact local dashboard on:

```text
http://127.0.0.1:3000
```

The UI shows WhatsApp connection status and scheduled jobs. Jobs can be created, edited, deleted, or sent immediately. The schedule editor provides daily, weekly, and monthly forms with an advanced cron fallback.

Recipients are managed by friendly aliases in the UI. Their real WhatsApp numbers remain in the ignored local `.env`; the local schedule stores placeholders such as `${WA_RECIPIENT_OFFICE}`. Numbers returned by the UI API are masked.

Files selected in the job editor are copied into `documents/` and schedule entries use repository-relative document paths. Per-file captions remain supported.

`Send now` executes the same job pipeline as scheduled delivery but uses a unique manual-run state key, so it performs a new send without changing scheduled occurrence state. The dashboard refuses a manual send while the same job already has an active scheduled or manual execution, preventing accidental concurrent duplicate delivery.

The dashboard also contains a persistent Activity panel. Structured runtime events are appended to `data/activity.jsonl` and streamed live to the browser with Server-Sent Events. The latest 100 events are shown by default and can be filtered by jobs, WhatsApp, or errors, or cleared from the UI. Activity events record job ids and document basenames but do not include recipient phone numbers, message bodies, captions, or absolute local paths.

The UI binds to `127.0.0.1` by default. `WA_UI_HOST` and `WA_UI_PORT` can override the bind address and port when needed.

## Operational status and job controls

Jobs are enabled by default. Set `"enabled": false` in the local `schedule.json`, or use the dashboard **Enable / Disable** button, to pause a job without deleting it. Disabled jobs are kept in the configuration but are not registered with the scheduler.

Each job card shows its next scheduled run and the latest scheduled run status. A failed run that already sent some items is shown as partial, including the number of completed items. Manual **Send now** executions remain separate from scheduled-run history.

The dashboard header shows the number of active jobs and the time when the current wa-scheduler process started.

## User service

On Linux systems with a working systemd user manager, wa-scheduler can run without an open terminal and restart after a process failure:

```bash
npm run service:install
npm run service:status
```

The installer generates `~/.config/systemd/user/wa-scheduler.service` from the current project path and the active Node.js executable, then enables and starts it. No home directory or NVM version is hardcoded in the repository.

To stop and remove the generated user service:

```bash
npm run service:remove
```

The service starts wa-scheduler when the systemd user manager starts. On WSL, this does not itself launch the WSL distribution from a fully stopped Windows session; WSL/systemd must be running for the Linux user service to run.

## Notifications

The dashboard can notify the operator independently from the job recipient. Notification settings are local runtime configuration stored in the ignored `schedule.json` and `.env`.

WhatsApp notifications can be sent to any configured recipient alias, typically `SELF`. Completion, failure, and partial-send events can be enabled separately for scheduled and manual **Send now** runs. Manual completion notifications explicitly say that the job was sent manually. Operator notifications identify the job recipient by alias when possible, list sent and pending items by filename, and include failure details. Each provider has an **Include message body** checkbox; it is off by default so the original job text is not copied into operator notifications unless explicitly enabled. Notification delivery uses a persistent per-run provider outbox. A successful provider is never repeated, while a failed provider remains pending in `data/state.json` and is retried in the background with bounded backoff after WhatsApp is ready, including after a process or service restart.

Notification settings are saved automatically. Checkbox and recipient changes are persisted immediately; ntfy server and topic fields are saved after a short typing pause. The dashboard shows `Saving…`, `Saved ✓`, or `Save failed`, retries one failed autosave, and warns before closing the page while unsaved notification changes remain. There is no separate notification save button.

For an independent phone push channel, enable the `ntfy` provider in the dashboard. The server defaults to `https://ntfy.sh`; the topic is stored locally as `WA_NTFY_TOPIC` in `.env` and is only exposed to the UI in masked form. Install an ntfy client on the phone and subscribe to the exact same topic before testing. The ntfy card can explicitly send the real server and topic to a selected WhatsApp recipient so the topic can be copied on the phone without revealing it in the normal dashboard or Activity log. **Send test** automatically enables the selected provider, flushes any pending autosave, and publishes a test message. A successful ntfy test confirms that the ntfy server accepted the publication; each test has a unique test id and the dashboard reports the ntfy message id returned by the server. Phone delivery still requires an active subscription to that exact topic.

The ntfy provider can report WhatsApp disconnections, which is useful because a disconnected WhatsApp session cannot reliably report its own failure through WhatsApp. Job notification messages never include file captions, full phone numbers, or ntfy topics. Job message bodies remain omitted unless **Include message body** is enabled for that notification provider.

## Automatic retries

Each job can optionally retry a failed scheduled run. Retry is disabled by default for existing jobs. The dashboard job editor exposes **Retry on failure**, retry attempts, and delay in minutes. The equivalent local schedule configuration is:

```json
{
  "retry": {
    "attempts": 5,
    "delayMinutes": 10
  }
}
```

`attempts` is the maximum number of automatic retries after the original scheduled attempt. Retry progress is persisted in `data/state.json`, including the next retry time. If wa-scheduler or the user service restarts while a retry is pending, the pending retry is restored from state. Disabled jobs keep their pending retry state paused and resume it when enabled again.

Retries use the immutable scheduled-run snapshot and the existing item-level send state, so edits made after a failure do not change the recipient, message, files, captions, or retry policy of an in-flight run, and already sent items are skipped. The first failure publishes a retry-scheduled operator notification. Intermediate retries remain quiet for providers that already received that notice because notification delivery is idempotent per provider. A successful retry publishes a recovered notification; exhausting all configured retries publishes an urgent exhausted notification.

## State retention

Completed and failed run records in `data/state.json` are pruned on startup after 90 days by default. Running jobs, pending scheduled retries, and records with pending notification deliveries are never pruned. Override the retention window with:

```dotenv
WA_STATE_RETENTION_DAYS=90
```

The value must be an integer from 1 to 3650 days. Notification outbox payloads are removed from state as soon as the corresponding provider delivery succeeds.

## Activity retention

`data/activity.jsonl` is pruned when wa-scheduler starts. Events older than 30 days are removed by default with an atomic rewrite. Override the retention window with:

```dotenv
WA_ACTIVITY_RETENTION_DAYS=30
```

The value must be an integer from 1 to 3650 days. The dashboard Activity toolbar shows the active retention window.
