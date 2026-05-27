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
- macOS or Linux (`date` — BSD or GNU, auto-detected)

Authenticate once before running:

```bash
gog auth add you@example.com --services calendar
```

## Usage

```
./src/lunch-scheduler.sh <email> [options]
./src/lunch-scheduler.sh --account <email> [options]

OPTIONS
  <email>                    Google account to use (required, positional or --account)
  --account <email>          Google account to use (same as positional)
  --timezone <tz>            IANA timezone name (default: system timezone)
  --calendar <name>          Calendar name or ID (default: primary)
  --start-times <HH:MM,...>  Preferred start times, tried in order
                             (default: 12:30,12:15,12:45,12:00,13:00,13:15,11:45,13:30,11:30)
  --durations <min,...>      Durations in minutes to try, longest first
                             (default: 60,45,30,15)
  --max-end <HH:MM>          Latest time lunch may end (default: 14:00)
  --window-weeks <n>         Weeks ahead beyond current week to schedule (default: 2)
  --decline-message <msg>    Message sent when declining meetings
  --dry-run, -n              Preview only, no changes made
```

### Examples

```bash
# Normal run (email as positional)
./src/lunch-scheduler.sh you@example.com

# Dry run to preview what would be scheduled
./src/lunch-scheduler.sh you@example.com -n

# Custom preferences
./src/lunch-scheduler.sh you@example.com \
  --timezone America/New_York \
  --start-times 12:00,12:30,13:00 \
  --durations 60,30 \
  --max-end 13:30
```

## Automation

Use the setup script to install or remove the scheduled job:

```bash
# Interactive — prompts for cron or launchd
./src/setup-schedule.sh you@example.com

# Explicit method
./src/setup-schedule.sh you@example.com --method launchd
./src/setup-schedule.sh you@example.com --method cron

# Custom time (default: 08:00)
./src/setup-schedule.sh you@example.com --hour 9 --minute 30

# Remove
./src/setup-schedule.sh --method launchd --remove
./src/setup-schedule.sh --method cron --remove
```

**launchd** (macOS only) — recommended: survives sleep/wake and reboots, fires even if the machine was asleep at the scheduled time.

**cron** — simpler, works on macOS and Linux.
