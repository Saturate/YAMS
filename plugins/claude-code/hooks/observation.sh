#!/bin/bash
# HUSK observation hook — streams observations to the server during a session.
# When uncompressed observations exceed the batch threshold, injects context
# telling the LLM to run the compress_session prompt.

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

# --- Parse hook input ---

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
[ -z "$SESSION_ID" ] && exit 0

# Detect the hook event from the input shape
EVENT=""
TOOL_NAME=""
if echo "$INPUT" | jq -e '.tool_name' >/dev/null 2>&1; then
	EVENT="PostToolUse"
	TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
elif echo "$INPUT" | jq -e '.prompt' >/dev/null 2>&1; then
	EVENT="UserPromptSubmit"
elif echo "$INPUT" | jq -e '.stop_hook_active' >/dev/null 2>&1; then
	EVENT="Stop"
else
	# Fallback: try to infer from session_end_reason (shouldn't hit this path)
	exit 0
fi

CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

# --- POST observation (fire-and-forget, short timeout) ---

PAYLOAD=$(jq -n \
	--arg sid "$SESSION_ID" \
	--arg event "$EVENT" \
	--arg tool_name "$TOOL_NAME" \
	--arg cwd "$CWD" \
	--argjson input "$INPUT" \
	'{
		session_id: $sid,
		event: $event,
		tool_name: (if $tool_name == "" then null else $tool_name end),
		cwd: (if $cwd == "" then null else $cwd end),
		prompt: ($input.prompt // null),
		tool_input: ($input.tool_input // null),
		tool_response: (($input.tool_response // "") | .[0:2000])
	}')

RESPONSE=$(curl -sf --max-time 2 -X POST "${HUSK_URL}/hooks/observation" \
	-H "Authorization: Bearer ${HUSK_KEY}" \
	-H "Content-Type: application/json" \
	-d "$PAYLOAD" 2>/dev/null) || exit 0

# --- Check threshold for compression injection ---

UNCOMPRESSED=$(echo "$RESPONSE" | jq -r '.uncompressed_count // 0')
THRESHOLD="${HUSK_COMPRESSION_BATCH_SIZE:-20}"

if [ "$UNCOMPRESSED" -ge "$THRESHOLD" ] 2>/dev/null; then
	jq -n \
		--arg event "$EVENT" \
		--arg sid "$SESSION_ID" \
		--arg count "$UNCOMPRESSED" \
		'{
			hookSpecificOutput: {
				hookEventName: $event,
				additionalContext: ("HUSK has " + $count + " uncompressed observations. Please use the compress_session prompt (session_id: " + $sid + ") to summarize them.")
			}
		}'
fi
