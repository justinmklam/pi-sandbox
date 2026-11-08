#!/bin/sh
# Print the last sandbox-denial / sandbox-override entries for this project's newest session.
# Usage: ./scripts/sandbox-events.sh [count]
set -eu

limit="${1:-8}"
slug=$(printf '%s' "$PWD" | sed 's#^/##; s#/#-#g')
dir="$HOME/.pi/agent/sessions/--${slug}--"

if [ ! -d "$dir" ]; then
  echo "no session directory for $PWD: $dir" >&2
  exit 1
fi

file=$(ls -t "$dir"/*.jsonl 2>/dev/null | head -1)
if [ -z "$file" ]; then
  echo "no session files in $dir" >&2
  exit 1
fi

echo "session: $file"
jq -c '
  select(.customType? == "sandbox-denial" or .customType? == "sandbox-override")
  | if .customType == "sandbox-denial"
      then {at: .data.at, kind: .data.kind, target: .data.target, tool: .data.tool,
            reason: .data.reason, fix: .data.fix, count: .data.count}
      else {at: .details.timestamp, kind: .details.kind, value: .details.value,
            action: .details.action}
    end
' "$file" | tail -"$limit"
