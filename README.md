# wa-scheduler

Scheduled WhatsApp document sender built on `whatsapp-web.js`.

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
      "file": "documents/report.pdf",
      "caption": "Документ"
    }
  ]
}
```

The matching local `.env` contains the private value:

```dotenv
WA_RECIPIENT_SELF=380XXXXXXXXX
```

`${VARIABLE}` placeholders can be used in string values in the schedule. Startup fails with a clear error when a referenced environment variable is missing.

Each job id must be unique. `schedule` uses cron syntax and is evaluated in the configured timezone.

## Run

```bash
npm start
```

On first start, scan the QR code from WhatsApp under **Linked devices**. The client registers configured jobs after WhatsApp becomes ready.

A successful send is recorded in `data/state.json` with a key composed from the job id and local calendar date, for example `monday-report:2026-07-13`. A job already recorded for that date is skipped, which prevents duplicate daily sends after a process restart.

Alternative paths can be selected with `WA_SCHEDULE_CONFIG` and `WA_STATE_FILE`.

## Test

```bash
npm test
```
