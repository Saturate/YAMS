#!/bin/bash
# HUSK SessionEnd hook - records session metadata as a memory and notifies the server
# Receives session event JSON on stdin

set -euo pipefail

# --- Resolve credentials: env vars > ~/.husk/credentials.json ---

HUSK_HOME="${HUSK_HOME:-$HOME/.husk}"

if [ -z "${HUSK_URL:-}" ] || [ -z "${HUSK_KEY:-}" ]; then
	CREDS_FILE="${HUSK_HOME}/credentials.json"
	if [ -f "$CREDS_FILE" ]; then
		HUSK_URL="${HUSK_URL:-$(jq -r '.url // empty' "$CREDS_FILE")}"
		HUSK_KEY="${HUSK_KEY:-$(jq -r '.apiKey // empty' "$CREDS_FILE")}"
	fi
fi

[ -z "${HUSK_URL:-}" ] || [ -z "${HUSK_KEY:-}" ] && exit 0

SESSION_DATA=$(cat)
CWD=$(echo "$SESSION_DATA" | jq -r '.cwd // empty')
SESSION_ID=$(echo "$SESSION_DATA" | jq -r '.session_id // empty')
REASON=$(echo "$SESSION_DATA" | jq -r '.session_end_reason // "unknown"')

[ -z "$SESSION_ID" ] && exit 0

# Try to get git remote for project association
GIT_REMOTE=""
if [ -n "$CWD" ] && [ -d "$CWD" ]; then
	GIT_REMOTE=$(cd "$CWD" && git remote get-url origin 2>/dev/null | sed 's|.*github.com[:/]||;s|\.git$||' || true)
fi

PROJECT_NAME=$(basename "${CWD:-unknown}")

# Notify server that session ended
curl -sf --max-time 2 -X POST "${HUSK_URL}/hooks/session-end" \
	-H "Authorization: Bearer ${HUSK_KEY}" \
	-H "Content-Type: application/json" \
	-d "$(jq -n --arg sid "$SESSION_ID" '{session_id: $sid}')" >/dev/null 2>&1 || true

# Post session summary as a memory
curl -sf -X POST "${HUSK_URL}/ingest" \
	-H "Authorization: Bearer ${HUSK_KEY}" \
	-H "Content-Type: application/json" \
	-d "$(jq -n \
		--arg summary "Coding session on ${PROJECT_NAME} (${REASON})" \
		--arg remote "$GIT_REMOTE" \
		--arg sid "$SESSION_ID" \
		--arg reason "$REASON" \
		--arg cwd "$CWD" \
		'{
			summary: $summary,
			git_remote: (if $remote == "" then null else $remote end),
			scope: "session",
			metadata: {session_id: $sid, reason: $reason, cwd: $cwd}
		}')" >/dev/null 2>&1 || true
