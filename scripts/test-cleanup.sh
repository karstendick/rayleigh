#!/bin/bash
# Trigger manual cleanup of old posts
# Usage: ./test-cleanup.sh [--local]

HOST="https://rayleigh-feed.fly.dev"
[[ "$1" == "--local" ]] && HOST="http://localhost:3000"

curl -s -X POST "$HOST/admin/cleanup" | jq .
