#!/usr/bin/env bash
# setup-schedule.sh — Install or remove the lunch-scheduler automated job

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCHEDULER="$SCRIPT_DIR/lunch-scheduler.sh"
LABEL="com.$(whoami).lunch-scheduler"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

ACCOUNT=""
HOUR=8
MINUTE=0
METHOD=""
ACTION="install"

usage() {
  cat <<'EOF'
Usage: ./src/setup-schedule.sh <email> [options]
       ./src/setup-schedule.sh --remove --method <cron|launchd>

OPTIONS
  <email>           Google account to schedule for (required for install)
  --method <m>      cron or launchd (prompted interactively if omitted)
  --hour <n>        Hour to run in 24h format (default: 8)
  --minute <n>      Minute to run (default: 0)
  --remove          Remove the scheduled job instead of installing
  -h, --help        Show this help
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --method)   METHOD="$2";   shift 2 ;;
    --hour)     HOUR="$2";     shift 2 ;;
    --minute)   MINUTE="$2";   shift 2 ;;
    --remove)   ACTION="remove"; shift ;;
    -h|--help)  usage ;;
    -*)  echo "Unknown option: $1" >&2; usage ;;
    *)   [[ -z "$ACCOUNT" ]] && ACCOUNT="$1" || { echo "Unexpected argument: $1" >&2; usage; }
         shift ;;
  esac
done

[[ "$ACTION" == "install" && -z "$ACCOUNT" ]] && { echo "Error: account email is required" >&2; usage; }

IS_MACOS=false
[[ "$(uname)" == "Darwin" ]] && IS_MACOS=true

# ── Pick method ───────────────────────────────────────────────────────────────
if [[ -z "$METHOD" ]]; then
  echo "Choose a scheduling method:"
  if $IS_MACOS; then
    echo "  1) launchd  (recommended on macOS — survives sleep/wake/reboot)"
    echo "  2) cron     (simpler, also works)"
  else
    echo "  1) cron     (Linux default)"
  fi
  printf "Choice [%s]: " "$( $IS_MACOS && echo '1/2' || echo '1' )"
  read -r choice
  if $IS_MACOS; then
    case "$choice" in
      1|"") METHOD="launchd" ;;
      2)    METHOD="cron" ;;
      *)    echo "Invalid choice" >&2; exit 1 ;;
    esac
  else
    METHOD="cron"
  fi
fi

if [[ "$METHOD" == "launchd" ]] && ! $IS_MACOS; then
  echo "Error: launchd is only available on macOS" >&2; exit 1
fi

TIME_DISPLAY=$(printf '%02d:%02d' "$HOUR" "$MINUTE")

# ── launchd ───────────────────────────────────────────────────────────────────
install_launchd() {
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${SCHEDULER}</string>
    <string>${ACCOUNT}</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>${HOUR}</integer><key>Minute</key><integer>${MINUTE}</integer></dict>
    <dict><key>Weekday</key><integer>2</integer><key>Hour</key><integer>${HOUR}</integer><key>Minute</key><integer>${MINUTE}</integer></dict>
    <dict><key>Weekday</key><integer>3</integer><key>Hour</key><integer>${HOUR}</integer><key>Minute</key><integer>${MINUTE}</integer></dict>
    <dict><key>Weekday</key><integer>4</integer><key>Hour</key><integer>${HOUR}</integer><key>Minute</key><integer>${MINUTE}</integer></dict>
    <dict><key>Weekday</key><integer>5</integer><key>Hour</key><integer>${HOUR}</integer><key>Minute</key><integer>${MINUTE}</integer></dict>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>/tmp/lunch-scheduler.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/lunch-scheduler.log</string>
</dict>
</plist>
EOF

  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "✓  Installed launchd job — runs at $TIME_DISPLAY Mon–Fri"
  echo "   Plist:  $PLIST"
  echo "   Log:    /tmp/lunch-scheduler.log"
  echo "   Remove: $0 --method launchd --remove"
}

remove_launchd() {
  if [[ -f "$PLIST" ]]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    rm "$PLIST"
    echo "✓  Removed launchd job ($PLIST)"
  else
    echo "No launchd job found at $PLIST"
  fi
}

# ── cron ──────────────────────────────────────────────────────────────────────
install_cron() {
  local entry="$MINUTE $HOUR * * 1-5 $SCHEDULER $ACCOUNT >> /tmp/lunch-scheduler.log 2>&1"

  # Remove any pre-existing entry for this scheduler
  ( crontab -l 2>/dev/null | grep -vF "$SCHEDULER" || true; echo "$entry" ) | crontab -
  echo "✓  Installed cron job — runs at $TIME_DISPLAY Mon–Fri"
  echo "   Log:    /tmp/lunch-scheduler.log"
  echo "   View:   crontab -l"
  echo "   Remove: $0 --method cron --remove"
}

remove_cron() {
  if crontab -l 2>/dev/null | grep -qF "$SCHEDULER"; then
    crontab -l 2>/dev/null | grep -vF "$SCHEDULER" | crontab -
    echo "✓  Removed cron job"
  else
    echo "No cron job found for $SCHEDULER"
  fi
}

# ── Dispatch ──────────────────────────────────────────────────────────────────
case "$METHOD" in
  launchd) [[ "$ACTION" == "install" ]] && install_launchd || remove_launchd ;;
  cron)    [[ "$ACTION" == "install" ]] && install_cron    || remove_cron    ;;
  *)       echo "Unknown method: $METHOD (use cron or launchd)" >&2; exit 1 ;;
esac
