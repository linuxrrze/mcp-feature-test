#!/usr/bin/env bash
# Stop the processes started by openwebui/start.sh.
WORK="${WORK:-/tmp/owui-mcp-test}"
[ -f "$WORK/pids" ] || { echo "no $WORK/pids"; exit 0; }
while read -r pid name; do
  kill "$pid" 2>/dev/null && echo "stopped $name ($pid)"
done < "$WORK/pids"
rm -f "$WORK/pids"
