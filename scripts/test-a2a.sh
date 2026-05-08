#!/usr/bin/env bash
# Quick A2A endpoint smoke test — run while the orchestrator is live.
# Usage:
#   bash scripts/test-a2a.sh                    # test localhost:8003
#   BASE_URL=https://your-ngrok-url bash scripts/test-a2a.sh

BASE_URL="${BASE_URL:-http://localhost:8003}"
MEMORY_URL="${BASE_URL}/memory"
PASS=0
FAIL=0

ok()   { echo "[PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }

echo "=== A2A Endpoint Test ==="
echo "Orchestrator : $BASE_URL"
echo "Health Memory: $MEMORY_URL"
echo ""

# ── 1. Agent card — orchestrator ───────────────────────────────────────────────
CARD=$(curl -sf "${BASE_URL}/.well-known/agent-card.json")
if echo "$CARD" | grep -q '"protocolVersion"'; then
  ok "GET ${BASE_URL}/.well-known/agent-card.json"
else
  fail "GET ${BASE_URL}/.well-known/agent-card.json — response: $CARD"
fi

# ── 2. Agent card — health memory ─────────────────────────────────────────────
CARD2=$(curl -sf "${MEMORY_URL}/.well-known/agent-card.json")
if echo "$CARD2" | grep -q '"protocolVersion"'; then
  ok "GET ${MEMORY_URL}/.well-known/agent-card.json"
else
  fail "GET ${MEMORY_URL}/.well-known/agent-card.json — response: $CARD2"
fi

# ── 3. message/send — orchestrator ────────────────────────────────────────────
PAYLOAD='{"jsonrpc":"2.0","id":"t1","method":"message/send","params":{"message":{"messageId":"m1","role":"user","parts":[{"kind":"text","text":"hello, what can you do?"}]}}}'
RESP=$(curl -sf -X POST "${BASE_URL}/" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" 2>&1)
if echo "$RESP" | grep -q '"result"'; then
  ok "POST ${BASE_URL}/ message/send"
elif echo "$RESP" | grep -q '"error"'; then
  fail "POST ${BASE_URL}/ — JSON-RPC error: $RESP"
else
  fail "POST ${BASE_URL}/ — unexpected response: $RESP"
fi

# ── 4. message/send — health memory ───────────────────────────────────────────
PAYLOAD2='{"jsonrpc":"2.0","id":"t2","method":"message/send","params":{"message":{"messageId":"m2","role":"user","parts":[{"kind":"text","text":"hello"}]}}}'
RESP2=$(curl -sf -X POST "${MEMORY_URL}/" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD2" 2>&1)
if echo "$RESP2" | grep -q '"result"'; then
  ok "POST ${MEMORY_URL}/ message/send"
elif echo "$RESP2" | grep -q '"error"'; then
  fail "POST ${MEMORY_URL}/ — JSON-RPC error: $RESP2"
else
  fail "POST ${MEMORY_URL}/ — unexpected response: $RESP2"
fi

# ── 5. Invalid envelope — should return -32600 ────────────────────────────────
BAD=$(curl -sf -X POST "${BASE_URL}/" \
  -H "Content-Type: application/json" \
  -d '{"not":"jsonrpc"}' 2>&1)
if echo "$BAD" | grep -q '"-32600"\|"Invalid JSON-RPC"'; then
  ok "POST ${BASE_URL}/ invalid envelope returns -32600"
else
  fail "POST ${BASE_URL}/ invalid envelope — unexpected response: $BAD"
fi

# ── 6. Unknown method — should return -32601 ──────────────────────────────────
UNK=$(curl -sf -X POST "${BASE_URL}/" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"x","method":"foo/bar","params":{}}' 2>&1)
if echo "$UNK" | grep -q '"-32601"\|"Method not supported"'; then
  ok "POST ${BASE_URL}/ unknown method returns -32601"
else
  fail "POST ${BASE_URL}/ unknown method — unexpected response: $UNK"
fi

# ── 7. text/plain content-type — should still parse ───────────────────────────
TP=$(curl -sf -X POST "${BASE_URL}/" \
  -H "Content-Type: text/plain" \
  -d '{"jsonrpc":"2.0","id":"tp","method":"message/send","params":{"message":{"messageId":"mtp","role":"user","parts":[{"kind":"text","text":"test"}]}}}' 2>&1)
if echo "$TP" | grep -q '"result"\|"-326"'; then
  ok "POST ${BASE_URL}/ with text/plain content-type accepted"
else
  fail "POST ${BASE_URL}/ text/plain — unexpected response: $TP"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
