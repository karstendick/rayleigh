#!/bin/bash
# Test the DID document endpoint
# Usage: ./test-did.sh [--local]

HOST="https://rayleigh-feed.fly.dev"
[[ "$1" == "--local" ]] && HOST="http://localhost:3000"

curl -s "$HOST/.well-known/did.json" | jq .
