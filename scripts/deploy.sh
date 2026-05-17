#!/bin/bash
set -e

if [[ -n $(git diff --cached --name-only) ]]; then
  echo "❌ Staged changes not committed. Commit first."
  exit 1
fi

CURRENT_SHA=$(git rev-parse HEAD)
SHORT_SHA=$(git rev-parse --short HEAD)
echo "🚀 Deploying $SHORT_SHA"

git push origin main

echo "📦 Triggering Railway build..."
railway up --ci --detach

URL="https://lecerclepoker-production.up.railway.app/api/version"
MAX_ATTEMPTS=30
for ((i=1; i<=MAX_ATTEMPTS; i++)); do
  sleep 10
  DEPLOYED=$(curl -s "$URL" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('commit',''))" 2>/dev/null || echo "")
  if [[ "$DEPLOYED" == "$CURRENT_SHA" ]] || [[ "$DEPLOYED" == "$SHORT_SHA" ]]; then
    echo "✅ Deploy verified: $SHORT_SHA"
    exit 0
  fi
  echo "  $i/$MAX_ATTEMPTS: deployed=${DEPLOYED:0:7}, expected=$SHORT_SHA"
done

echo "❌ Deploy did not propagate after 5 min. Last seen: ${DEPLOYED:0:7}"
exit 1
