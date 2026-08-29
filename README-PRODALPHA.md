# Prod Alpha 부하테스트 (s12)

`docs/prodalphaloadtestscenario.md` 를 그대로 구현한 단일 실행 시나리오.

## 이 시나리오가 기존 s1~s11 과 다른 점

| | s7_mixed (기존) | **s12_prod_alpha (신규)** |
|---|---|---|
| 조회 비율 | 별도 45% | 별도로 세지 않음 — 각 주문 흐름의 준비 단계 |
| DINE_IN | 기본 꺼짐 | **35%** (POS 20 + Kiosk 15) |
| 후불 결제 | 없음 | PENDING 생성까지 (`POST /api/v1/payments`) |
| name tag | 내부 규칙 | 문서 8장 태그 그대로 |
| 최대 VU | 100 (문서 기준 500) | 100 (문서 7장) |

## workload 비율

| 완료 업무 흐름 | 비율 | executor |
|---|---:|---|
| POS TAKEOUT 주문 | 25% | staff |
| Kiosk TAKEOUT 주문 | 25% | kiosk |
| POS DINE_IN + 후불 결제 | 20% | staff |
| Kiosk DINE_IN + 후불 결제 | 15% | kiosk |
| 대기열 등록·조회·상태 변경 | 10% | staff |
| 주문 상세·상태 / 운영 조회 | 5% | staff |

직원 세션과 키오스크 세션을 한 VU 에 섞으면 `401 AMBIGUOUS_AUTHENTICATION` 이므로
executor 를 **직원 60% / 키오스크 40%** 로 나눴다. 각 executor 안에서 위 비율을
100% 로 정규화해 선택한다.

## 실제 결제는 호출하지 않는다

호출하는 것은 `POST /api/v1/payments` 하나뿐이다. 계약상 `{ orderId }` 만 받고
`PENDING` 스냅샷을 돌려주는 내부 상태 전이이며 외부 PG 를 타지 않는다.

**호출하지 않는 것 (코드에 아예 없음)**

- `POST /api/v1/payments/{id}/confirm` — `paymentKey` 필요, Toss 승인
- `POST /api/v1/payments/{id}/cancel` — Toss 취소
- 그 밖의 모든 PG 승인·취소·환불

후불 결제 단계 자체를 빼려면 `-e POSTPAY=0`.

## 부하 단계 (문서 7장)

| 단계 | 총 VU | 기간 | 직원 | 키오스크 |
|---|---:|---:|---:|---:|
| Smoke | 5 | 30초 | 3 | 2 |
| Stage 1 | 10 | 5분 | 6 | 4 |
| Stage 2 | 30 | 10분 | 18 | 12 |
| Stage 3 | 50 | 10분 | 30 | 20 |
| Stage 4 | 100 | 15분 | 60 | 40 |

총 40분.

## 필요한 시드 데이터

| 항목 | 최소 | 권장 | 이유 |
|---|---:|---:|---|
| 직원 계정 | 60 | 100 | 직원 VU 수 이상 (VU 당 1계정) |
| 키오스크 기기 | 40 | 50 | 키오스크 VU 수 이상 |
| 상품 | 12 | 24 | 주문 라인 다양성 |
| **테이블** | **300** | **500** | 아래 참고 |

### 테이블이 왜 500개인가

테이블은 한 번에 주문 1건만 받고, 주문을 끝내도 해제가 **최대 30초** 걸린다
(`TableReservationReleaseRecovery` 의 `PT30S`). 그래서 DINE_IN 처리량 상한은
`테이블 수 ÷ 35초` 다.

```
VU 100 → 초당 약 17 iteration → DINE_IN 35% = 초당 6건
필요 테이블 = 6 × 35초 × 1.5 ≈ 300개
```

부족하면 `503` 이 늘어나고, **서버 성능이 아니라 테이블 회전율을 재게 된다.**
503 은 실패율에서 빼고 `table_blocked` 카운터로 따로 센다 — 이 값이 크면
결과를 그대로 읽으면 안 된다.

각 VU 에는 겹치지 않는 테이블 블록이 배정되고 iteration 마다 블록 안에서
돌려 쓴다. 500개 / 100 VU = VU 당 5개이며, 같은 테이블 재사용 간격은 약 85초라
30초 해제 지연보다 충분히 길다.

## 실행

```bash
export BASE_URL=https://origin.doro.minseok.click
export RUN_ID=PRODALPHA-001
export TENANT_CODE=e2e-auth-active
export OWNER_ID=e2e-role-owner
export OWNER_PW='...'          # 셸 히스토리에 남기지 말 것
export STAFF_PW='...'

# 1) 상품·테이블·직원
SEED_STAFF=100 SEED_TABLES=500 SEED_PRODUCTS=24 ./run-prod-alpha.sh seed

# 2) 키오스크 기기 40대 등록 → credential 출력
./run-prod-alpha.sh seed-kiosk -e SEED_KIOSK=40
# 출력된 export KIOSK_SECRETS='...' 줄을 그대로 실행
# 이미 등록된 기기가 있으면 -e ROTATE=1 로 재발급

export STAFF_COUNT=100
export KIOSK_COUNT=40

# 3) 스모크 — 스크립트 오류부터 없앤다
./run-prod-alpha.sh smoke

# 4) 본 실행 (40분)
./run-prod-alpha.sh run
```

## 결과 읽는 법

`http_req_duration` 은 반드시 `{name:...}` 으로 끊어서 본다. 태그 없이 전체 p95 를
보면 조회와 쓰기가 섞여 의미가 없다.

```
http_req_duration{name:pos_takeout_order}
http_req_duration{name:kiosk_dinein_order}
http_req_duration{name:menu_list}
...
```

커스텀 지표

| 지표 | 뜻 |
|---|---|
| `business_flow{flow:...}` | 흐름별 실행 수. 비율이 의도대로 나왔는지 확인 |
| `table_blocked{channel:...}` | 테이블 미해제로 막힌 DINE_IN 수. **크면 결과 무효** |
| `postpay_pending{channel:...}` | PENDING 결제 생성 성공 수 |
| `order_to_status_ms` | 주문 생성 → 상세·상태 조회 완료까지 |
| `expected_errors{case:...}` | 의도된 오류 (409 등). 실패율과 분리 |

k6 결과와 CloudWatch 대시보드(`doro-erp-prod-alpha-operations`)를 같은 시간축으로
정렬해서 본다.

## 테스트 후 정리

```bash
# Redis 멱등키 — FLUSHALL 금지
redis-cli --scan --pattern "*${RUN_ID}-*" | xargs -r redis-cli DEL
```

주문·대기열·테이블 상태는 테스트 전용 업체(`e2e-auth-active`) 안에만 생기므로
그 업체 데이터만 정리한다.
