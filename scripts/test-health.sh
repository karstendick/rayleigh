#!/bin/bash
# Test the health endpoint
# Usage: ./test-health.sh [--local]

HOST="https://rayleigh-feed.fly.dev"
[[ "$1" == "--local" ]] && HOST="http://localhost:3000"

if ! response=$(curl -s --max-time 5 "$HOST/health"); then
  echo "Error: Health check timed out (>5s)" >&2
  exit 1
fi

echo "$response" | jq .
