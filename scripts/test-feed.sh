#!/bin/bash
# Test the getFeedSkeleton endpoint
# Usage: ./test-feed.sh [--local] [limit]

HOST="https://rayleigh-feed.fly.dev"
LIMIT=10

for arg in "$@"; do
  if [[ "$arg" == "--local" ]]; then
    HOST="http://localhost:3000"
  elif [[ "$arg" =~ ^[0-9]+$ ]]; then
    LIMIT="$arg"
  fi
done

FEED_URI="at://did:plc:3fshmponqrqbbyaroachu5ax/app.bsky.feed.generator/rayleigh"

curl -s "$HOST/xrpc/app.bsky.feed.getFeedSkeleton?feed=$FEED_URI&limit=$LIMIT" | jq .
