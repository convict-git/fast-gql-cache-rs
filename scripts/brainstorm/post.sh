#!/bin/sh
# Posts one message to a brainstorm board (docs/agents/brainstorm-protocol.md).
#
#   post.sh <draft-file>
#
# The board is $BRAINSTORM_BOARD, or the parent of this script's directory when the
# script lives in <board>/bin. The draft's first line must be a valid header whose
# seq is the next free one and whose sender holds the turn (the moderator always may).
# The message is published atomically as <board>/<seq>-<from>.md, so a reader never
# sees half a message and two agents can never publish the same seq.
set -eu

draft=${1:?usage: post.sh <draft-file>}
board=${BRAINSTORM_BOARD:-$(cd "$(dirname "$0")/.." && pwd)}
[ -d "$board" ] || { echo "post: no board at $board" >&2; exit 2; }

header=$(head -n 1 "$draft" | tr -d '\r')
kinds='open|position|challenge|evidence|concede|synthesis|ack|hold|ask-user|close'
pattern="^\[from: (claude|gpt|user)\] \[seq: [0-9]+\] \[re: ([0-9]+|-)\] \[item: (A[0-9]+|meta)\] \[kind: ($kinds)\] \[next: (claude|gpt|user)\]$"
if ! printf '%s\n' "$header" | grep -Eq "$pattern"; then
  echo "post: the first line is not a valid header:" >&2
  echo "  $header" >&2
  echo "  expected: [from: X] [seq: N] [re: N|-] [item: A1|meta] [kind: K] [next: X]" >&2
  exit 1
fi
field() { printf '%s\n' "$header" | sed -E "s/.*\[$1: ([^]]*)\].*/\1/"; }
from=$(field from); seq=$(field seq); kind=$(field kind)

last=$(ls "$board" | grep -E '^[0-9]{4}-(claude|gpt|user)\.md$' | sort | tail -n 1 || true)
if [ -n "$last" ]; then
  last_seq=$(printf '%s' "$last" | cut -c1-4 | sed 's/^0*//')
  last_next=$(head -n 1 "$board/$last" | tr -d '\r' | sed -E 's/.*\[next: ([^]]*)\].*/\1/')
else
  last_seq=0; last_next=$from
fi
expected=$((${last_seq:-0} + 1))
if [ "$seq" -ne "$expected" ]; then
  echo "post: seq is $seq but the next free seq is $expected; read the board and redraft." >&2
  exit 1
fi
if [ "$from" != user ] && [ "$from" != "$last_next" ]; then
  echo "post: it is $last_next's turn (see $last), not $from's." >&2
  exit 1
fi

case $kind in
  open|close) ;;
  *)
    words=$(tail -n +2 "$draft" | awk '
      /<details>/ { d = 1 }
      /^---[[:space:]]*$/ { f = 1 }
      !d && !f { n += NF }
      /<\/details>/ { d = 0 }
      END { print n + 0 }')
    if [ "$words" -gt 300 ]; then
      echo "post: $words words outside <details>; the limit is 300. Trim or move evidence into <details>." >&2
      exit 1
    fi
    ;;
esac

name=$(printf '%04d-%s.md' "$seq" "$from")
mkdir -p "$board/.tmp"
tmp="$board/.tmp/$name.$$"
cp "$draft" "$tmp"
# ln fails if the name already exists, which makes publishing a seq atomic.
if ! ln "$tmp" "$board/$name" 2>/dev/null; then
  rm -f "$tmp"
  echo "post: $name was published by someone else first; read the board and redraft." >&2
  exit 1
fi
rm -f "$tmp"
echo "posted $board/$name"
