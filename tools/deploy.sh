#!/usr/bin/env bash
# 저장소 생성 후 배포: 푸시 → GitHub Pages 활성화 → 라이브 확인
# 사용: tools/deploy.sh <owner> [repo]   예) tools/deploy.sh irene2407 reels-cut-studio
set -euo pipefail

OWNER="${1:?owner를 넣어 주세요 (irene2407 또는 day-craft)}"
REPO="${2:-reels-cut-studio}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT"

if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin "https://github.com/${OWNER}/${REPO}.git"
else
  git remote set-url origin "https://github.com/${OWNER}/${REPO}.git"
fi

git push -u origin main

# Pages 켜기 (이미 켜져 있으면 409가 나므로 무시)
gh api -X POST "repos/${OWNER}/${REPO}/pages" \
  -f build_type=legacy \
  -f 'source[branch]=main' \
  -f 'source[path]=/' >/dev/null 2>&1 || true

echo "Pages 상태를 확인합니다…"
for i in $(seq 1 20); do
  STATUS=$(gh api "repos/${OWNER}/${REPO}/pages" --jq .status 2>/dev/null || echo "")
  echo "  시도 $i: ${STATUS:-확인 못 함}"
  if [ "$STATUS" = "built" ]; then break; fi
  sleep 10
done

URL="https://${OWNER}.github.io/${REPO}/"
echo "라이브 확인: $URL"
curl -sS -o /dev/null -w "  HTTP %{http_code}\n" "$URL"
