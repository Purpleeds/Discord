#!/bin/bash
# Runs every regression suite against a fresh server on a throwaway database.
#   DB=postgresql://user:pass@localhost/chat_test regression/run.sh [suite ...]
# Needs: Postgres, `npm install`, and (for the *_ui suites) playwright-core plus
# a Chromium - set CHROME=/path/to/chrome if Playwright's own isn't found.
cd "$(dirname "$0")/.." || exit 1
export DB=${DB:-postgresql://chat:chat@localhost/chat_test}
export BASE=${BASE:-http://localhost:4100}
PORT=$(node -e "console.log(new URL(process.env.BASE).port || 80)")
LOG=regression/shots/server.log; mkdir -p regression/shots
start() {
  DATABASE_URL=$DB PGSSL=false RATE_LIMITS=off PORT=$PORT LINK_PREVIEW_TEST_HOSTS=127.0.0.1:45871 nohup node server.js >> $LOG 2>&1 &
  for i in $(seq 1 40); do curl -s -o /dev/null "$BASE/healthz" && return; sleep 0.5; done
  echo "server did not start - see $LOG"; exit 1
}
stop() { pkill -x -f '(\S*/)?node server\.js' 2>/dev/null; sleep 1; }
SUITES=${*:-v3_sessions v3_unread v3_files permissions profiles batch5_api batch4_api ssrf bots_api bans setup_api calls_api batch1 batch2 batch4_ui previews_ui bots_ui setup_ui motion calls_ui v3_ui roles_ui batch5_ui stickers big_assets popups notifier_ui notifier_store notifier_offer phone_ui hide_roles site_admins roles_banners read_receipts video_avatars notifier_tls}
FAILED=0
# always test a server started here, on $DB - never one that happens to be running already
stop
for s in $SUITES; do
  curl -s -o /dev/null "$BASE/healthz" || start   # some suites restart the server; bring it back if one left it down
  out=$(timeout 600 node regression/$s.test.js 2>&1); code=$?
  echo "$s: $(echo "$out" | grep -E 'passed [0-9]+' | tail -1)$([ $code -ne 0 ] && echo '  <-- FAILED')"
  [ $code -ne 0 ] && { echo "$out" | grep -E '^FAIL|Error' | head -15; FAILED=1; }
done
stop
exit $FAILED
