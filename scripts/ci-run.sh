#!/usr/bin/env bash
# CI helper: run a command; on failure, surface the tail of its output as a
# GitHub annotation (readable from the API even when raw logs aren't).
log=$(mktemp)
"$@" >"$log" 2>&1
code=$?
cat "$log"
if [ $code -ne 0 ]; then
  msg=$(tail -c 6000 "$log" | sed -e 's/%/%25/g' -e 's/\r//g' | awk '{printf "%s%%0A", $0}')
  echo "::error title=$1 $2 failed::${msg}"
fi
exit $code
