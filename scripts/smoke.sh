#!/usr/bin/env bash
# End-to-end check against a running server: create a program, post updates,
# draft the weekly report through the Workflow, approve it, and check the result.
# Usage: npm run dev:offline   (in another terminal)   then   bash scripts/smoke.sh [base-url]
set -euo pipefail
BASE="${1:-http://localhost:8787}"
post() { curl -sf -X POST "$BASE$1" -H 'content-type: application/json' -d "$2"; }
get()  { curl -sf "$BASE$1"; }

ID=$(post /api/programs '{"name":"EU edge capacity expansion"}' | jq -r .id)
echo "program: $ID"

post "/api/programs/$ID/updates" '{"author":"Priya","text":"Canary rollout: done in 3 PoPs. EU racks: delayed by vendor, new date 2026-12-12."}' >/dev/null
post "/api/programs/$ID/updates" '{"author":"Marco","text":"Risk: high chance the optics shortage blocks Q1 turn-ups. Waiting on DC ops for power in FRA, needed by 2026-12-01."}' \
  | jq -r '.messages[-1].content'

# Updates need a name, so every change records who made it.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/programs/$ID/updates" -H 'content-type: application/json' -d '{"text":"no name"}')
[ "$code" = "400" ] || { echo "expected 400 without author, got $code"; exit 1; }

STATE=$(get "/api/programs/$ID")
[ "$(echo "$STATE" | jq -r '.risks[0].updatedBy')" = "Marco" ] || { echo "expected risk updatedBy Marco"; exit 1; }
echo "risk last updated by: $(echo "$STATE" | jq -r '.risks[0].updatedBy')"
echo "health: $(echo "$STATE" | jq -r .health.overall)  milestones: $(echo "$STATE" | jq '.milestones|length')  risks: $(echo "$STATE" | jq '.risks|length')  deps: $(echo "$STATE" | jq '.dependencies|length')"
[ "$(echo "$STATE" | jq -r .health.overall)" = "RED" ] || { echo "expected RED (open high risk)"; exit 1; }

REPORT=$(post "/api/programs/$ID/reports" '{}' | jq -r .id)
echo "report workflow: $REPORT"
for i in $(seq 1 30); do
  STATUS=$(get "/api/programs/$ID" | jq -r '.reports[0].status')
  [ "$STATUS" = "awaiting_approval" ] && break
  sleep 1
done
echo "report status: $STATUS"
[ "$STATUS" = "awaiting_approval" ] || exit 1

# A second request while one is in flight returns the same report, not a new one.
[ "$(post "/api/programs/$ID/reports" '{}' | jq -r .id)" = "$REPORT" ] || { echo "duplicate report started"; exit 1; }

# Reviewing needs a name.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/programs/$ID/reports/$REPORT/review" -H 'content-type: application/json' -d '{"approved":true}')
[ "$code" = "400" ] || { echo "expected 400 without reviewer, got $code"; exit 1; }

post "/api/programs/$ID/reports/$REPORT/review" '{"approved":true,"reviewer":"Sahar","note":"","editedText":"Overall: RED\nSummary: edited by the reviewer."}' >/dev/null
for i in $(seq 1 30); do
  STATUS=$(get "/api/programs/$ID" | jq -r '.reports[0].status')
  [ "$STATUS" = "approved" ] && break
  sleep 1
done
FINAL=$(get "/api/programs/$ID" | jq -r '.reports[0].final')
echo "report status: $STATUS"
echo "final starts: $(echo "$FINAL" | head -2 | tail -1)"
[ "$STATUS" = "approved" ] && [[ "$FINAL" == *"edited by the reviewer"* ]] || exit 1

post "/api/programs/$ID/schedule" '{"enabled":true}' | jq -r '"weekly schedule: " + .weeklySchedule'
echo "OK"
