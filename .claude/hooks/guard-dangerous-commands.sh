#!/usr/bin/env bash
set -u

INPUT="$(cat)"

COMMAND="$(
python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    print(data.get("tool_input", {}).get("command", ""))
except Exception:
    print("")
' <<<"$INPUT"
)"

# Normalize for conservative pattern matching.
LOWER="$(printf '%s' "$COMMAND" | tr '[:upper:]' '[:lower:]')"

block() {
  printf '%s\n' "Blocked by project safety hook: $1" >&2
  exit 2
}

# Catastrophic filesystem operations.
if printf '%s' "$LOWER" | grep -Eq '(^|[;&|[:space:]])rm[[:space:]]+-[^[:space:]]*r[^[:space:]]*f[^[:space:]]*[[:space:]]+(/|/\*|~)([[:space:]]|$)'; then
  block "recursive force deletion of a system/home root is not allowed."
fi

# Destructive cleanup of uncommitted repository work.
if printf '%s' "$LOWER" | grep -Eq 'git[[:space:]]+reset[[:space:]]+--hard([[:space:]]|$)'; then
  block "git reset --hard can destroy user work. Use a scoped, reversible approach."
fi

if printf '%s' "$LOWER" | grep -Eq 'git[[:space:]]+clean[[:space:]]+-[^[:space:]]*f'; then
  block "git clean -f can destroy untracked user work."
fi

if printf '%s' "$LOWER" | grep -Eq 'git[[:space:]]+(checkout[[:space:]]+--[[:space:]]+\.|restore[[:space:]]+\.)'; then
  block "bulk discard of working-tree changes is not allowed."
fi

# Remote history rewriting.
if printf '%s' "$LOWER" | grep -Eq 'git[[:space:]]+push([^;&|]*)(--force|-f)([[:space:]]|$)'; then
  block "force-push is not allowed from the coding agent."
fi

# Machine-level destructive operations.
if printf '%s' "$LOWER" | grep -Eq '(^|[;&|[:space:]])(mkfs(\.[a-z0-9]+)?|shutdown|reboot|poweroff)([[:space:]]|$)'; then
  block "machine-level destructive command is not allowed."
fi

if printf '%s' "$LOWER" | grep -Eq 'dd[[:space:]].*of=/dev/'; then
  block "raw device writes are not allowed."
fi

# Project-specific: taking the rethink container down without releasing the router's DNAT
# rules first leaves every appliance attached to nothing. Most return on a 60 s keepalive,
# but the washer-class ones use 1200 s and have been measured gone for twenty-five minutes;
# two restarts inside that window make them undeploy themselves. scripts/deploy.sh releases
# the rules first and the reconciler restores them afterwards. See CLAUDE.md rule 1.
if printf '%s' "$LOWER" | grep -Eq 'docker[[:space:]]+(restart|stop|rm|kill)[^;&|]*[[:space:]]rethink([[:space:]]|$)'; then
  block "stopping the rethink container directly strands the appliances. Use scripts/deploy.sh, or release DNAT first: curl -fsS -X POST http://127.0.0.1:44401/api/router/dnat/release"
fi

# Avoid blind remote-code execution. Download and inspect first.
if printf '%s' "$LOWER" | grep -Eq '(curl|wget)[^|]*\|[[:space:]]*(sudo[[:space:]]+)?(sh|bash)([[:space:]]|$)'; then
  block "piping downloaded content directly into a shell is not allowed; download and inspect it first."
fi

exit 0
