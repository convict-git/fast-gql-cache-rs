#!/bin/sh
# Blocks until it is <who>'s turn on a brainstorm board (docs/agents/brainstorm-protocol.md).
#
#   wait-turn.sh <claude|gpt|user> [timeout-seconds=540] [poll-seconds=5]
#
# Exits 0 and prints the newest message's path once its header says [next: <who>];
# exits 1 on timeout (run it again). The board is $BRAINSTORM_BOARD, or the parent of
# this script's directory when the script lives in <board>/bin.
set -eu

who=${1:?usage: wait-turn.sh <claude|gpt|user> [timeout-seconds] [poll-seconds]}
timeout=${2:-540}
poll=${3:-5}
board=${BRAINSTORM_BOARD:-$(cd "$(dirname "$0")/.." && pwd)}
[ -d "$board" ] || { echo "wait-turn: no board at $board" >&2; exit 2; }

waited=0
while :; do
  last=$(ls "$board" | grep -E '^[0-9]{4}-(claude|gpt|user)\.md$' | sort | tail -n 1 || true)
  if [ -n "$last" ] && head -n 1 "$board/$last" | tr -d '\r' | grep -q "\[next: $who\]"; then
    echo "$board/$last"
    exit 0
  fi
  if [ "$waited" -ge "$timeout" ]; then
    echo "wait-turn: still not $who's turn after ${timeout}s (newest: ${last:-none}); run again." >&2
    exit 1
  fi
  sleep "$poll"
  waited=$((waited + poll))
done
