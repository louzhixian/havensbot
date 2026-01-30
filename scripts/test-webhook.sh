#!/bin/bash
# Test LemonSqueezy webhook endpoint locally

set -e

PORT=${HTTP_PORT:-3000}
URL="http://localhost:$PORT/api/webhooks/lemonsqueezy"

echo "Testing webhook endpoint at $URL"
echo ""

# Test 1: Health check
echo "1. Testing health endpoint..."
curl -s "http://localhost:$PORT/health" | jq .
echo ""

# Test 2: Missing signature
echo "2. Testing missing signature (should fail)..."
curl -s -X POST "$URL" \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}' | jq .
echo ""

# Test 3: Invalid signature
echo "3. Testing invalid signature (should fail)..."
curl -s -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "X-Signature: invalid" \
  -d '{"test": "data"}' | jq .
echo ""

echo "✓ Webhook endpoint basic tests completed"
echo ""
echo "To test with a real LemonSqueezy webhook:"
echo "1. Set LEMONSQUEEZY_WEBHOOK_SECRET in .env"
echo "2. Use ngrok or similar to expose local server"
echo "3. Configure webhook URL in LemonSqueezy dashboard"
