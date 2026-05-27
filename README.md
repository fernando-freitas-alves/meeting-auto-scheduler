# meeting-auto-scheduler

Automatically schedules a daily "Lunch" Out-of-Office block on Google Calendar, working around existing meetings.

## What it does

For every weekday in a rolling window (today through Friday of the current week + `--window-weeks`), the script:

- Skips days with an all-day PTO/OOO block
- Leaves existing Lunch events alone if no meetings conflict
- Deletes and reschedules a conflicting Lunch to the next best slot
- Creates a new Lunch OOO event on days that have none

"Maybe" and "Declined" RSVP responses are treated as free time and don't block a slot.

## Priority logic

Start times tried in order (default): `12:30 → 12:15 → 12:45 → 12:00 → 13:00 → 13:15 → 11:45 → 13:30 → 11:30`

Durations tried longest-first (default): `60 → 45 → 30 → 15 minutes` (event must end by `--max-end`, default `14:00`)

## Requirements

- [`gogcli`](https://github.com/steipete/gogcli) — `brew install steipete/tap/gogcli`
- `jq` — `brew install jq`
- macOS (uses BSD `date`)

Authenticate once before running:

```bash
gog auth add you@example.com --services calendar
```

## Usage

```
./src/lunch-scheduler.sh --account <email> [options]

OPTIONS
  --account <email>          Google account to use (required)
  --timezone <tz>            IANA timezone name (default: system timezone)
  --calendar <name>          Calendar name or ID (default: primary)
  --start-times <HH:MM,...>  Preferred start times, tried in order
                             (default: 12:30,12:15,12:45,12:00,13:00,13:15,11:45,13:30,11:30)
  --durations <min,...>      Durations in minutes to try, longest first
                             (default: 60,45,30,15)
  --max-end <HH:MM>          Latest time lunch may end (default: 14:00)
  --window-weeks <n>         Weeks ahead beyond current week to schedule (default: 2)
  --decline-message <msg>    Message sent when declining meetings
  --dry-run                  Preview only, no changes made
```

### Examples

```bash
# Normal run
./src/lunch-scheduler.sh --account you@example.com

# Dry run to preview what would be scheduled
./src/lunch-scheduler.sh --account you@example.com --dry-run

# Custom preferences
./src/lunch-scheduler.sh --account you@example.com \
  --timezone America/New_York \
  --start-times 12:00,12:30,13:00 \
  --durations 60,30 \
  --max-end 13:30
```

## Automation

Run at 8 AM every weekday via cron:

```
0 8 * * 1-5 /path/to/src/lunch-scheduler.sh --account you@example.com >> /tmp/lunch-scheduler.log 2>&1
```
