# wa-scheduler

Scheduled WhatsApp document sender built on `whatsapp-web.js`.

## Setup

Use Node.js 22 or newer, install dependencies, and create the local schedule configuration:

```bash
npm install
cp config/schedule.example.json config/schedule.json
```

Edit `config/schedule.json` and place documents under `documents/`. The local schedule, scheduler state, WhatsApp authentication data, and document contents are ignored by Git.

## Schedule configuration

```json
{
  "timezone": "Europe/Kyiv",
  "jobs": [
    {
      "id": "monday-report",
      "schedule": "0 8 * * 1",
      "recipient": "380XXXXXXXXX",
      "file": "documents/report.pdf",
      "caption": "Документ"
    }
  ]
}
```

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
