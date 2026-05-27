#!/usr/bin/env bash
# =============================================================================
# lunch-scheduler.sh  —  Auto-schedule Lunch Out-of-Office on Google Calendar
# =============================================================================
#
# WHAT IT DOES
#   For every weekday in the rolling window (today → Friday of current week
#   + --window-weeks), this script:
#     • Skips days with all-day PTO/OOO blocks
#     • Leaves existing Lunch events alone (unless a new meeting now overlaps)
#     • Reschedules a conflicting Lunch to the next best slot
#     • Creates a new "Lunch" Out-of-Office event on days that have none
#
#   "Maybe" / "Declined" attendee status counts as FREE (won't block a slot)
#
# REQUIREMENTS
#   • gog (gogcli)  →  brew install steipete/tap/gogcli
#   • jq            →  brew install jq
#   • macOS (uses BSD date)
#   • gog authenticated for your account:
#       gog auth add <email> --services calendar
#
# USAGE
#   ./lunch-scheduler.sh <email> [options]
#   ./lunch-scheduler.sh --account <email> [options]
#
# OPTIONS
#   <email>                    Google account to use (required, positional or --account)
#   --account <email>          Google account to use (same as positional)
#   --timezone <tz>            IANA timezone name (default: system timezone)
#   --calendar <name>          Calendar name or ID (default: primary)
#   --start-times <HH:MM,...>  Preferred start times, tried in order
#                              (default: 12:30,12:15,12:45,12:00,13:00,13:15,11:45,13:30,11:30)
#   --durations <min,...>      Durations in minutes to try, longest first
#                              (default: 60,45,30,15)
#   --max-end <HH:MM>          Latest time lunch may end (default: 14:00)
#   --window-weeks <n>         Weeks ahead beyond current week to schedule (default: 2)
#   --decline-message <msg>    Message sent when declining meetings (default: "Decline because I'm lunching")
#   --dry-run, -n              Preview only — no changes made
#   -h, --help                 Show this help
#
# AUTOMATION (run at 8 AM every weekday)
#   crontab -e
#   Add:  0 8 * * 1-5 /path/to/lunch-scheduler.sh you@example.com >> /tmp/lunch-scheduler.log 2>&1
#
# NOTE ON EVENT TITLE
#   The --title flag is passed to gog; if your version of gogcli doesn't support
#   it yet, the event will be created as "Out of office" (the Google default for
#   OOO blocks). Everything else — time, decline message, OOO type — still works.
# =============================================================================

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
DEFAULT_CALENDAR="primary"
DEFAULT_START_TIMES="12:30,12:15,12:45,12:00,13:00,13:15,11:45,13:30,11:30"
DEFAULT_DURATIONS="60,45,30,15"
DEFAULT_MAX_END="14:00"
DEFAULT_WINDOW_WEEKS=2
DEFAULT_DECLINE_MSG="Decline because I'm lunching"

detect_system_tz() {
  readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||' || date +%Z
}

# ── Argument parsing ──────────────────────────────────────────────────────────
GOG_ACCOUNT=""
CALENDAR="$DEFAULT_CALENDAR"
TZ_NAME=""
START_TIMES_RAW="$DEFAULT_START_TIMES"
DURATIONS_RAW="$DEFAULT_DURATIONS"
MAX_END_STR="$DEFAULT_MAX_END"
WINDOW_WEEKS=$DEFAULT_WINDOW_WEEKS
DECLINE_MSG="$DEFAULT_DECLINE_MSG"
DRY_RUN=false

usage() {
  grep '^# ' "$0" | sed -n '/^# USAGE/,/^# [A-Z][A-Z]/{ /^# [A-Z][A-Z]/!p }' | sed 's/^# \?//'
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --account)          GOG_ACCOUNT="$2";    shift 2 ;;
    --timezone)         TZ_NAME="$2";        shift 2 ;;
    --calendar)         CALENDAR="$2";       shift 2 ;;
    --start-times)      START_TIMES_RAW="$2"; shift 2 ;;
    --durations)        DURATIONS_RAW="$2";  shift 2 ;;
    --max-end)          MAX_END_STR="$2";    shift 2 ;;
    --window-weeks)     WINDOW_WEEKS="$2";   shift 2 ;;
    --decline-message)  DECLINE_MSG="$2";    shift 2 ;;
    --dry-run|-n)       DRY_RUN=true;         shift ;;
    -h|--help)          usage ;;
    -*) echo "Unknown option: $1" >&2; usage ;;
    *)  [[ -z "$GOG_ACCOUNT" ]] && GOG_ACCOUNT="$1" || { echo "Unexpected argument: $1" >&2; usage; }
        shift ;;
  esac
done

[[ -z "$GOG_ACCOUNT" ]] && { echo "Error: account email is required" >&2; usage; }
[[ -z "$TZ_NAME" ]] && TZ_NAME=$(detect_system_tz)

# ── Helpers ───────────────────────────────────────────────────────────────────
log()  { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }

# HH:MM → minutes since midnight (safe for leading zeros)
to_m() { echo $(( 10#${1%%:*} * 60 + 10#${1##*:} )); }

# minutes → HH:MM
fm()   { printf '%02d:%02d' $(( $1 / 60 )) $(( $1 % 60 )); }

# Date helpers — auto-detect BSD (macOS) vs GNU date
if date -j -f '%Y-%m-%d' '1970-01-01' '+%Y-%m-%d' &>/dev/null; then
  dow()        { date -jf '%Y-%m-%d' "$1" '+%u'; }
  add_days()   { date -jf '%Y-%m-%d' -v+${2}d "$1" '+%Y-%m-%d'; }
  sub_days()   { date -jf '%Y-%m-%d' -v-${2}d "$1" '+%Y-%m-%d'; }
  to_rfc3339() { local o; o=$(TZ="$TZ_NAME" date -jf '%Y-%m-%dT%H:%M:%S' "$1" '+%z'); echo "$1${o:0:3}:${o:3:2}"; }
else
  dow()        { date -d "$1" '+%u'; }
  add_days()   { date -d "$1 + $2 days" '+%Y-%m-%d'; }
  sub_days()   { date -d "$1 - $2 days" '+%Y-%m-%d'; }
  to_rfc3339() { local o; o=$(TZ="$TZ_NAME" date -d "${1/T/ }" '+%z'); echo "$1${o:0:3}:${o:3:2}"; }
fi

# ── Build arrays from comma-separated inputs ──────────────────────────────────
IFS=',' read -ra _STARTS_HMS <<< "$START_TIMES_RAW"
PREF_STARTS=()
for hm in "${_STARTS_HMS[@]}"; do
  PREF_STARTS+=( "$(to_m "${hm// /}")" )
done

IFS=',' read -ra DURATIONS <<< "$DURATIONS_RAW"
# trim any spaces
for i in "${!DURATIONS[@]}"; do DURATIONS[$i]="${DURATIONS[$i]// /}"; done

MAX_END_MIN=$(to_m "$MAX_END_STR")

# ── Date range ────────────────────────────────────────────────────────────────
TODAY=$(date '+%Y-%m-%d')
DOW_TODAY=$(dow "$TODAY")
MON_CURR=$(sub_days "$TODAY" $(( DOW_TODAY - 1 )))
END_DATE=$(add_days "$MON_CURR" $(( 4 + WINDOW_WEEKS * 7 )))

log "=== Lunch Scheduler$( $DRY_RUN && echo ' [DRY RUN]' || true ) ==="
log "Account:      $GOG_ACCOUNT"
log "Timezone:     $TZ_NAME"
log "Calendar:     $CALENDAR"
log "Window:       $TODAY → $END_DATE  (current week + ${WINDOW_WEEKS})"
log "Start times:  $START_TIMES_RAW"
log "Durations:    $DURATIONS_RAW min"
log "Max end:      $MAX_END_STR"

# ── Fetch all events once ─────────────────────────────────────────────────────
log "Fetching events from Google Calendar…"

EVENTS_FILE=$(mktemp /tmp/lunch-sched-XXXXXX.json)
trap 'rm -f "$EVENTS_FILE"' EXIT

RAW=$(gog --account "$GOG_ACCOUNT" calendar events "$CALENDAR" \
        --from "$TODAY" --to "$END_DATE" --all-pages --json 2>/dev/null) || RAW='{"events":[]}'

# Handle both {"events":[]} and plain array responses
echo "$RAW" | jq 'if type=="array" then {events:.} else . end' > "$EVENTS_FILE"

TOTAL=$(jq '.events | length' "$EVENTS_FILE")
log "Fetched $TOTAL events"

# ── jq helpers ────────────────────────────────────────────────────────────────
read -r -d '' JQ_MY_RSVP <<'JQ' || true
def my_rsvp:
  if .attendees == null then "accepted"
  else (.attendees | map(select(.self == true)) | first | .responseStatus // "accepted")
  end;
JQ

read -r -d '' JQ_IS_BLOCKING <<'JQ' || true
def is_blocking:
  .status != "cancelled" and
  .start.dateTime != null and
  (my_rsvp | . != "tentative" and . != "declined" and . != "maybe");
JQ

# ── Process each weekday ──────────────────────────────────────────────────────
current="$TODAY"

while [[ ! "$current" > "$END_DATE" ]]; do

  DOW_CUR=$(dow "$current")
  if (( DOW_CUR >= 6 )); then
    current=$(add_days "$current" 1)
    continue
  fi

  DAY_JSON=$(jq --arg d "$current" \
    '{events: [.events[] | select(
        .status != "cancelled" and
        ((.start.dateTime // .start.date) | startswith($d))
      )]}' "$EVENTS_FILE")

  # ── Skip PTO days ──────────────────────────────────────────────────────────
  PTO_COUNT=$(jq '.events | map(select(.eventType == "outOfOffice" and .start.date != null)) | length' \
    <<< "$DAY_JSON")
  if (( PTO_COUNT > 0 )); then
    log "⏭  $current  PTO/all-day OOO — skipping"
    current=$(add_days "$current" 1)
    continue
  fi

  # ── Check for an existing Lunch OOO ────────────────────────────────────────
  LUNCH_JSON=$(jq '.events | map(select(.summary == "Lunch" and .eventType == "outOfOffice")) | first // empty' \
    <<< "$DAY_JSON")

  if [[ -n "$LUNCH_JSON" ]]; then
    L_START_RAW=$(jq -r '.start.dateTime' <<< "$LUNCH_JSON")
    L_END_RAW=$(jq -r '.end.dateTime'     <<< "$LUNCH_JSON")
    L_ID=$(jq -r '.id'                    <<< "$LUNCH_JSON")

    L_START=$(echo "$L_START_RAW" | sed 's/.*T\([0-9][0-9]:[0-9][0-9]\).*/\1/')
    L_END=$(echo "$L_END_RAW"     | sed 's/.*T\([0-9][0-9]:[0-9][0-9]\).*/\1/')
    LS=$(to_m "$L_START"); LE=$(to_m "$L_END")

    CONFLICTS=$(jq \
      --argjson ls "$LS" --argjson le "$LE" \
      "${JQ_MY_RSVP}${JQ_IS_BLOCKING}"'
      .events | map(
        select(is_blocking and .summary != "Lunch") |
        {
          sm: ((.start.dateTime | split("T")[1] | split(":") | (.[0]|tonumber)*60 + (.[1]|tonumber))),
          em: ((.end.dateTime   | split("T")[1] | split(":") | (.[0]|tonumber)*60 + (.[1]|tonumber)))
        } |
        select(.sm < $le and .em > $ls)
      ) | length
    ' <<< "$DAY_JSON")

    if (( CONFLICTS == 0 )); then
      log "✓  $current  Lunch ${L_START}–${L_END} — OK, no conflicts"
      current=$(add_days "$current" 1)
      continue
    fi

    log "⚡ $current  Lunch ${L_START}–${L_END} — conflict detected, rescheduling"
    if [[ "$DRY_RUN" == false ]]; then
      gog --account "$GOG_ACCOUNT" calendar delete "$CALENDAR" "$L_ID" --force 2>/dev/null \
        || log "   ⚠  Could not delete $L_ID — will attempt to create anyway"
    fi
    DAY_JSON=$(jq --arg id "$L_ID" '.events |= map(select(.id != $id))' <<< "$DAY_JSON")
  fi

  # ── Find the best available slot ────────────────────────────────────────────
  BUSY=$(jq "${JQ_MY_RSVP}${JQ_IS_BLOCKING}"'
    .events | map(
      select(is_blocking) |
      {
        sm: ((.start.dateTime | split("T")[1] | split(":") | (.[0]|tonumber)*60 + (.[1]|tonumber))),
        em: ((.end.dateTime   | split("T")[1] | split(":") | (.[0]|tonumber)*60 + (.[1]|tonumber)))
      }
    )
  ' <<< "$DAY_JSON")

  BEST_S="" BEST_E=""

  for dur in "${DURATIONS[@]}"; do
    for s in "${PREF_STARTS[@]}"; do
      e=$(( s + dur ))
      (( e > MAX_END_MIN )) && continue

      OVERLAP=$(jq --argjson s "$s" --argjson e "$e" \
        'map(select(.sm < $e and .em > $s)) | length' <<< "$BUSY")

      if (( OVERLAP == 0 )); then
        BEST_S=$(fm "$s"); BEST_E=$(fm "$e")
        break 2
      fi
    done
  done

  if [[ -z "$BEST_S" ]]; then
    log "❌ $current  No lunch slot available (fully booked until $MAX_END_STR)"
    current=$(add_days "$current" 1)
    continue
  fi

  # ── Create the Out-of-Office event ─────────────────────────────────────────
  DUR_USED=$(( $(to_m "$BEST_E") - $(to_m "$BEST_S") ))
  log "✅ $current  Creating Lunch OOO  ${BEST_S}–${BEST_E}  (${DUR_USED} min)"

  if [[ "$DRY_RUN" == false ]]; then
    gog --account "$GOG_ACCOUNT" calendar ooo "$CALENDAR" \
        --from "$(to_rfc3339 "${current}T${BEST_S}:00")" \
        --to   "$(to_rfc3339 "${current}T${BEST_E}:00")" \
        --summary "Lunch" \
        --auto-decline new \
        --decline-message "$DECLINE_MSG" \
      && log "   Created ✓" \
      || log "   ⚠  gog returned an error — check flags, try: gog calendar ooo --help"
  else
    log "   [dry-run] gog calendar ooo $CALENDAR --from ${current}T${BEST_S}:00 --to ${current}T${BEST_E}:00"
  fi

  current=$(add_days "$current" 1)
done

log "=== Done ==="
