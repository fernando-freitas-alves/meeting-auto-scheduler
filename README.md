# meeting-auto-scheduler

<p align="center">
  <img src="assets/preview.png" alt="Lunch OOO events on Google Calendar" width="80%">
</p>

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

## Example output

```
[08:00:01] === Lunch Scheduler ===
[08:00:01] Account:      you@example.com
[08:00:01] Timezone:     America/New_York
[08:00:01] Calendar:     primary
[08:00:01] Window:       2026-05-27 → 2026-06-12  (current week + 2)
[08:00:01] Start times:  12:30,12:15,12:45,12:00,13:00,13:15,11:45,13:30,11:30
[08:00:01] Durations:    60,45,30,15 min
[08:00:01] Max end:      14:00
[08:00:01] Fetching events from Google Calendar…
[08:00:02] Fetched 23 events
[08:00:02] ✓  2026-05-27  Lunch 12:30–13:30 — OK, no conflicts
[08:00:02] ⚡ 2026-05-28  Lunch 12:30–13:30 — conflict detected, rescheduling
[08:00:02] ✅ 2026-05-28  Creating Lunch OOO  13:00–14:00  (60 min)
[08:00:03]    Created ✓
[08:00:03] ✅ 2026-05-29  Creating Lunch OOO  12:30–13:30  (60 min)
[08:00:04]    Created ✓
[08:00:04] ⏭  2026-05-30  PTO/all-day OOO — skipping
[08:00:04] ❌ 2026-05-31  No lunch slot available (fully booked until 14:00)
[08:00:04] ✅ 2026-06-02  Creating Lunch OOO  12:15–13:15  (60 min)
[08:00:05]    Created ✓
[08:00:05] ⏭  2026-06-03  Already OOO during lunch window — skipping
[08:00:05] ✅ 2026-06-04  Creating Lunch OOO  12:30–13:00  (30 min)
[08:00:06]    Created ✓
[08:00:06] === Done ===
```

Dry-run output looks the same but all `Creating` lines are prefixed with `[dry-run]` and no calendar changes are made.

## Example output

```
[08:00:01] === Lunch Scheduler ===
[08:00:01] Account:      you@example.com
[08:00:01] Timezone:     America/New_York
[08:00:01] Calendar:     primary
[08:00:01] Window:       2026-05-27 → 2026-06-12  (current week + 2)
[08:00:01] Start times:  12:30,12:15,12:45,12:00,13:00,13:15,11:45,13:30,11:30
[08:00:01] Durations:    60,45,30,15 min
[08:00:01] Max end:      14:00
[08:00:01] Fetching events from Google Calendar…
[08:00:02] Fetched 23 events
[08:00:02] ✓  2026-05-27  Lunch 12:30–13:30 — OK, no conflicts
[08:00:02] ⚡ 2026-05-28  Lunch 12:30–13:30 — conflict detected, rescheduling
[08:00:02] ✅ 2026-05-28  Creating Lunch OOO  13:00–14:00  (60 min)
[08:00:03]    Created ✓
[08:00:03] ✅ 2026-05-29  Creating Lunch OOO  12:30–13:30  (60 min)
[08:00:04]    Created ✓
[08:00:04] ⏭  2026-05-30  PTO/all-day OOO — skipping
[08:00:04] ❌ 2026-05-31  No lunch slot available (fully booked until 14:00)
[08:00:04] ✅ 2026-06-02  Creating Lunch OOO  12:15–13:15  (60 min)
[08:00:05]    Created ✓
[08:00:05] ⏭  2026-06-03  Already OOO during lunch window — skipping
[08:00:05] ✅ 2026-06-04  Creating Lunch OOO  12:30–13:00  (30 min)
[08:00:06]    Created ✓
[08:00:06] === Done ===
```

Dry-run output looks the same but all `Creating` lines are prefixed with `[dry-run]` and no calendar changes are made.

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

When no `--method` is given, the script prompts interactively. On macOS it defaults to **launchd**; on Linux it skips the prompt and uses **cron** automatically.
