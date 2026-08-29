#!/usr/bin/env bash
# 부하 테스트 실행 스크립트 (문서 7장 실행 순서)
#
#   ./run.sh smoke          # 모든 시나리오를 1 VU / 30초로 (스크립트 오류 제거용)
#   ./run.sh basic          # 시나리오 1~6
#   ./run.sh full           # 시나리오 1~10
#   ./run.sh stress         # 한계 탐색만 (시나리오 10)
#   ./run.sh s2             # 특정 시나리오만
#   ./run.sh seed           # 초기 데이터 생성
#
# 환경 변수:
#   BASE_URL   (필수) Edge 주소
#   RUN_ID     (필수) 회차 식별자. 예: LOADTEST-007
#   TENANT_CODE OWNER_ID OWNER_PW STAFF_PW KIOSK_SECRET
#   VU_NORMAL VU_PEAK VU_LIMIT   기본 10 / 50 / 100

set -euo pipefail
cd "$(dirname "$0")"

: "${BASE_URL:?BASE_URL 을 지정하세요}"
: "${RUN_ID:?RUN_ID 를 지정하세요. 예: RUN_ID=LOADTEST-007}"

OUT_DIR="results/${RUN_ID}"
mkdir -p "$OUT_DIR"

run_one() {
  local name="$1"; shift
  local file="$1"; shift
  echo ""
  echo "=========================================="
  echo " ${name}"
  echo "=========================================="
  k6 run \
    --summary-export "${OUT_DIR}/${name}.json" \
    --out "json=${OUT_DIR}/${name}.ndjson" \
    "$@" "$file"
}

SCENARIOS=(
  "s1_pos_browse"
  "s2_pos_order"
  "s3_kiosk_order"
  "s4_entry_queue"
  "s5_fulfillment"
  "s6_idempotency"
  "s7_mixed"
  "s8_spike"
  "s9_soak"
  "s10_stress"
  "s11_dine_in"
)

case "${1:-full}" in
  seed)
    k6 run seed/seed.js
    ;;
  smoke)
    # 문서 7장 2단계 — 스크립트 자체의 오류를 먼저 없앤다
    for s in "${SCENARIOS[@]}"; do
      SMOKE=1 run_one "smoke_${s}" "scenarios/${s}.js" -e SMOKE=1
    done
    ;;
  basic)
    # 기준 부하가 확정되지 않았을 때 여기까지만 실행한다 (문서 0장)
    for s in "${SCENARIOS[@]:0:6}"; do
      run_one "$s" "scenarios/${s}.js"
    done
    ;;
  stress)
    run_one "s10_stress" "scenarios/s10_stress.js"
    ;;
  full)
    for s in "${SCENARIOS[@]}"; do
      run_one "$s" "scenarios/${s}.js"
    done
    ;;
  s*)
    for s in "${SCENARIOS[@]}"; do
      if [[ "$s" == "$1"* ]]; then
        run_one "$s" "scenarios/${s}.js"
        exit 0
      fi
    done
    echo "알 수 없는 시나리오: $1" >&2
    exit 1
    ;;
  *)
    echo "사용법: $0 [seed|smoke|basic|full|s1..s9]" >&2
    exit 1
    ;;
esac

echo ""
echo "결과: ${OUT_DIR}/"
