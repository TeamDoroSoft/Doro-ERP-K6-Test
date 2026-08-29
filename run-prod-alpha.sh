#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Prod Alpha 부하테스트 실행 (문서 prodalphaloadtestscenario.md)
#
#   ./run-prod-alpha.sh smoke      # 5 VU / 30초 — 스크립트 점검
#   ./run-prod-alpha.sh seed       # 상품·테이블·직원 시드
#   ./run-prod-alpha.sh seed-kiosk # 키오스크 기기 등록 + credential 발급
#   ./run-prod-alpha.sh run        # 본 실행 (10 → 30 → 50 → 100 VU, 40분)
#
# 필수 환경변수: BASE_URL RUN_ID TENANT_CODE OWNER_ID OWNER_PW STAFF_PW
# 키오스크 흐름에는 KIOSK_SECRETS 가 필요합니다 (seed-kiosk 결과).
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"

: "${BASE_URL:?BASE_URL 을 지정하세요}"
: "${RUN_ID:?RUN_ID 를 지정하세요}"
: "${TENANT_CODE:?TENANT_CODE 를 지정하세요}"

OUT="results/${RUN_ID}"
mkdir -p "$OUT"

case "${1:-run}" in
  seed)
    k6 run "${@:2}" seed/seed.js
    ;;
  seed-kiosk)
    k6 run "${@:2}" seed/seed_kiosk.js
    ;;
  smoke)
    k6 run -e SMOKE=1 \
      --summary-export "${OUT}/smoke.json" \
      "${@:2}" scenarios/s12_prod_alpha.js
    ;;
  run)
    if [ -z "${KIOSK_SECRETS:-}" ]; then
      echo "⚠ KIOSK_SECRETS 가 비어 있습니다. 키오스크 흐름(전체의 40%)이 실패합니다." >&2
      echo "  먼저 ./run-prod-alpha.sh seed-kiosk 를 실행하세요." >&2
      read -r -p "그래도 계속할까요? [y/N] " a
      [ "$a" = "y" ] || exit 1
    fi
    k6 run \
      --summary-export "${OUT}/s12_prod_alpha.json" \
      --out "json=${OUT}/s12_prod_alpha.ndjson" \
      "${@:2}" scenarios/s12_prod_alpha.js
    ;;
  *)
    echo "사용법: $0 [seed|seed-kiosk|smoke|run]" >&2
    exit 1
    ;;
esac

echo ""
echo "결과: ${OUT}/"
