#!/bin/bash
# Test the describeFeedGenerator endpoint
# Usage: ./test-describe.sh [--local]

HOST="https://rayleigh-feed.fly.dev"
[[ "$1" == "--local" ]] && HOST="http://localhost:3000"

curl -s "$HOST/xrpc/app.bsky.feed.describeFeedGenerator" | jq .
