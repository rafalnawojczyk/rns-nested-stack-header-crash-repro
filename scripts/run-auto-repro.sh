#!/usr/bin/env bash
# Launches the app on the connected Android device/emulator, starts the in-app auto repro loop and waits
# until the crash shows up in logcat (or MAX_SECONDS pass).
# Usage: scripts/run-auto-repro.sh [MAX_SECONDS]   (requires adb; the app must already be installed)
set -uo pipefail
APP=com.rnsnestedrepro
MAX_SECONDS=${1:-600}
PATTERN='Cannot remove child|already has a parent|non-stack container'

adb shell am force-stop "$APP"
adb logcat -c
# The rnsrepro://auto deep link launches the app and starts the auto repro loop
adb shell am start -a android.intent.action.VIEW -d "rnsrepro://auto" "$APP" >/dev/null
echo "Auto repro started, waiting up to ${MAX_SECONDS}s…"

for t in $(seq 5 5 "$MAX_SECONDS"); do
  sleep 5
  if adb logcat -d | grep -qE "$PATTERN" || [ -z "$(adb shell pidof "$APP")" ]; then
    echo "💥 Crashed after ~${t}s"
    adb logcat -d | grep -m6 -E "$PATTERN|FATAL EXCEPTION|\[repro\] iteration" | cut -c1-220
    exit 1
  fi
done
echo "No crash within ${MAX_SECONDS}s"
