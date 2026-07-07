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

Place documents under `documents/`. Document contents, scheduler state, WhatsApp authentication data, and `.env` are ignored by Git.

## Schedule configuration

The schedule itself is version-controlled in `schedule.json`:

```json
{
  "timezone": "Europe/Kyiv",
  "jobs": [
    {
      "id": "monday-report",
      "schedule": "0 8 * * 1",
      "recipient": "${WA_RECIPIENT_SELF}",
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

Scheduler progress is recorded in `data/state.json` under a key composed from the job id and local calendar date, for example `monday-report:2026-07-13`. Message and file sends are persisted separately. If a multi-item job fails partway through, a later run skips already recorded items and resumes with the first unsent item. The job is marked complete only after every configured item has been sent.

State written by the earlier single-document scheduler remains compatible: a record already marked with `status: "sent"` is treated as a completed job.

Alternative paths can be selected with `WA_SCHEDULE_CONFIG` and `WA_STATE_FILE`.

## Test

```bash
npm test
```
