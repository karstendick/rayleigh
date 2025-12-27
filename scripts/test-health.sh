#!/bin/bash
# Test the health endpoint
# Usage: ./test-health.sh [--local]

HOST="https://rayleigh-feed.fly.dev"
[[ "$1" == "--local" ]] && HOST="http://localhost:3000"

curl -s "$HOST/health" | jq .
