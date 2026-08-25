# Doro ERP k6 부하 테스트

[`docs/Doro-ERP-k6-부하테스트-시나리오.md`](docs/Doro-ERP-k6-부하테스트-시나리오.md) 의 시나리오 1~10을 구현한 것.

대상 서비스: [Doro-ERP-Service](https://github.com/TeamDoroSoft/Doro-ERP-Service)

## 필요한 것

- [k6](https://k6.io/docs/get-started/installation/) 0.50 이상
- 부하 테스트 전용 환경의 Edge 주소
- 테스트 전용 업체와 OWNER 계정 (수동 생성 — 아래 참고)

설정값은 `.env.example` 을 복사해 쓴다. 계정 비밀번호는 커밋하지 않는다.

## 폴더 구조

```
Doro-ERP-K6-Test/
├─ config/
│  ├─ env.js          실행 설정 (주소, 계정, 부하 기준값)
│  └─ thresholds.js   합격 기준 + 자동 중단 조건
├─ lib/
│  ├─ http.js         태그 규칙, 멱등키, 의도된 오류 처리
│  ├─ auth.js         직원 로그인 / 키오스크 활성화 / CSRF
│  ├─ api.js          엔드포인트별 호출 함수
│  ├─ setupData.js    setup() 에서 상품·테이블 확보
│  ├─ mixed.js        혼합 부하 (직원 몫)
│  └─ kioskMixed.js   혼합 부하 (키오스크 몫)
├─ scenarios/         시나리오 1~10 (s10 = 한계 탐색)
├─ seed/seed.js       초기 데이터 생성
└─ run.sh             실행 스크립트
```

## 실행 순서

```bash
export BASE_URL=https://edge.dev.example.com
export RUN_ID=LOADTEST-007
export TENANT_CODE=loadtest007
export OWNER_ID=owner01
export OWNER_PW='...'

# 0) 업체와 최초 OWNER 계정은 수동으로 만들어 둔다 (아래 "선행 작업" 참고)

# 1) 초기 데이터 생성
SEED_STAFF=500 SEED_TABLES=500 ./run.sh seed

# 2) 스모크 — 스크립트 오류부터 없앤다
./run.sh smoke

# 3) 시나리오 1~6
./run.sh basic

# 4) 한계 찾기 — 100 → 200 → 300 → 400 → 500 계단식
./run.sh stress

# 5) 전부
VU_LIMIT=500 ./run.sh full
```

### 한계 탐색 (시나리오 10)

```bash
./run.sh stress                                      # 기본 계단
STRESS_STEPS=200,400,600,800 STEP_DURATION=3m ./run.sh stress   # 직접 지정
```

결과는 단계별로 끊어서 본다.

```
http_req_duration{step:100} … {step:500}
http_req_failed{step:100}   … {step:500}
```

**마지막 단계까지 멀쩡하면 실패한 테스트다.** 한계를 못 찾은 것이므로 단계를 더 올려 다시 실행한다.

결과는 `results/$RUN_ID/` 에 쌓인다.

## 부하 기준값

`config/env.js` 의 기본값이다. 환경 변수로 덮어쓴다.

| 변수 | 기본값 | 뜻 |
| --- | ---: | --- |
| `VU_NORMAL` | 100 | 정상 |
| `VU_PEAK` | 300 | 피크 |
| `VU_LIMIT` | 500 | 한계 확인 (혼합 부하의 100%) |

열린 모델(초당 요청) 값은 위 값에서 `/6` 으로 환산한다. 사용자 1명이 대략
6초에 1회 요청한다고 본 것이다. 실측 후 `RPS_NORMAL` 등으로 직접 지정해도 된다.

---

## 매장 주문(DINE_IN)은 기본적으로 꺼져 있다 ⚠

`DINE_IN_RATIO` 기본값이 **0** 이다. 즉 모든 주문이 포장(TAKEOUT)으로 나간다.

**이유** — 테이블은 한 번에 주문 1건만 받고(DB 유니크 인덱스), 주문을 완료해도 해제가
최대 30초 걸린다. 그래서 매장 주문의 처리량은 서버 성능이 아니라 아래로 결정된다.

```
테이블 수 ÷ 해제 주기 = 매장 주문 처리량 상한
500개 ÷ 35초 ≈ 초당 14건
```

이걸 섞어 돌리면 **서버 성능이 아니라 테이블 회전율을 재게 된다.**

**매장 주문을 켜려면**

```bash
DINE_IN_RATIO=0.15 ./run.sh s2
```

켤 때는 테이블이 충분해야 한다. 부족하면 setup 단계에서 필요한 개수를 경고로 알려준다.

```
필요 테이블 = 초당 매장 주문 수 × TABLE_RELEASE_SECONDS × 1.5
```

테이블 때문에 막힌 요청은 `503` 으로 오는데, 서버 장애가 아니므로 실패율에서 빼고
`table_blocked` 카운터로 따로 센다.

## 명세 확인 중 발견한 것

스크립트를 짜면서 실제 계약을 확인한 결과, 문서 작성 시점에 몰랐던 것들이 나왔다.
**시나리오 문서에 반영이 필요하다.**

### 0. 테이블 해제가 최대 30초 걸린다 ⚠ **제품 확인 필요**

주문을 완료·취소해도 테이블이 바로 안 풀린다. 해제 작업을 큐에 넣고,
`release-retry-delay`(기본 30초) 주기의 스케줄러가 처리한다. 동기 해제 시도는 없다.

즉 **손님이 나가고 완료를 눌러도 다음 주문까지 평균 15초, 최대 30초 막힌다.**

설계 방향(큐 적재 후 재시도)은 맞다. 문제는 설정값 이름이 **재시도 간격**인데
첫 시도까지 이 주기를 기다린다는 점이다.

**팀에 확인할 것** — 의도한 동작인가?

**고치는 법** — `PT30S` → `PT2S` (설정만), 또는 완료 시점에 동기 해제를 한 번
시도하고 실패 시에만 스케줄러에 위임 (코드 변경).

**확인 방법** — 개발 환경에서 `매장 주문 → 완료 → 같은 테이블로 재주문` 즉시 시도.

### 1. 조리 목록은 주문 생성만으로 채워지지 않는다 ⚠

조리 항목(fulfillment)은 HTTP 로 만들어지지 않는다. `OrderAccepted` 이벤트를
소비할 때 `PREPARING` 상태로 자동 생성된다. 즉 **결제 승인 흐름이 선행돼야 한다.**

문서는 결제를 부하 대상에서 제외했으므로, 시나리오 5의 조리 목록이 계속 빌 수 있다.
스크립트는 이 경우 `fulfillment_empty` 카운터를 올리고 주문 완료/취소까지만 검증한다.

**팀에서 정할 것** — 조리 흐름을 제대로 부하 테스트하려면 셋 중 하나가 필요하다.

- 결제를 Stub 으로 두고 승인까지 태운다 (문서 9장 수정 필요)
- 부하 테스트 환경에서만 주문을 자동 ACCEPTED 로 넘기는 설정을 둔다
- 조리 흐름 부하 테스트를 범위에서 뺀다

### 2. 직원과 키오스크는 같은 VU 에서 섞을 수 없다

`SESSION` 쿠키와 `DORO_KIOSK_DEVICE` 쿠키가 동시에 있으면
`401 AMBIGUOUS_AUTHENTICATION` 이 난다. 그래서 혼합 부하(시나리오 7~9)를
직원 executor 와 키오스크 executor 로 나눴다.

### 3. 키오스크가 못 하는 것

- 주문 목록 조회 / 완료 / 취소 → `403 ACCESS_DENIED`
- 주문 상세 조회는 가능하지만 `X-Order-Access-Token` 헤더가 필요하다
  (주문 생성 응답의 `orderAccessToken` 값)

### 4. 오류 코드가 문서 예상과 다르다

| 상황 | 문서 예상 | 실제 |
| --- | --- | --- |
| 비활성 테이블로 DINE_IN | 409 또는 422 | **400 VALIDATION_FAILED** |
| 같은 멱등키 + 다른 본문 | 409 `IDEMPOTENCY_KEY_REUSED` | 409 (code 는 구현상 `IDP_CONFLICT`) |
| 종료된 대기 재전이 | 409 | 409 `STATE_CONFLICT` |

멱등키 충돌은 **문서와 구현의 code 문자열이 다르다.** 스크립트는 code 로 판정하지
않고 HTTP 409 로만 본다.

### 5. `GET /api/v1/tables` 는 ACTIVE 만 돌려준다

그래서 "비활성 테이블로 주문하면 거절되는지" 검증은 **비활성 테이블 id 를 미리
확보해 두지 않으면 실행할 수 없다.** 현재 스크립트에는 넣지 않았다.
필요하면 시드 단계에서 테이블 하나를 만들고 비활성화한 뒤 그 id 를 넘겨야 한다.

### 6. 로그인은 `setup()` 이 아니라 VU 당 1회

`setup()` 의 쿠키는 VU 로 전달되지 않는다(각자 별도 쿠키 jar). 그래서 문서 규칙 2의
"setup() 에서 1회"는 실제로는 **"VU 당 1회, 이후 재사용"** 으로 구현했다.
매 반복 로그인을 피한다는 취지는 그대로다. `lib/auth.js` 의 `ensureStaff()` 참고.

### 7. 요청 본문에 금액을 넣지 않는다

주문 생성 요청에는 `productId` 와 `quantity` 만 보낸다. 단가·총액 필드는 계약에
아예 없고 서버가 계산한다. 옵션(선택 항목) 필드도 없다.

### 8. Provider Admin 은 자동화하기 어렵다

업체 생성과 최초 OWNER 생성은 `/api/v1/provider/**` 경로인데, `admin` 프로파일로
뜬 Edge 에서만 노출되고 OIDC 로그인이 필요하다. `seed/seed.js` 는 **업체와 OWNER 가
이미 있다고 가정**하고 그 아래(카테고리·상품·테이블·직원)만 만든다.

### 9. 키오스크 기기 등록 API 를 못 찾았다

`POST /api/v1/kiosk-auth/activate` 는 이미 등록된 기기를 **활성화**하는 것이다.
기기 자체를 등록하는 경로는 확인하지 못했다. 시나리오 3과 혼합 부하의 키오스크
부분을 돌리려면 `device001~` 을 미리 등록해 둬야 한다.

---

## 지표 읽는 법

기본 지표 외에 커스텀 지표를 넣었다.

| 지표 | 뜻 |
| --- | --- |
| `expected_errors` | 의도된 오류 건수. 실패율과 분리해서 센다 |
| `relogin_count` | 세션이 끊겨 재로그인한 횟수. Soak 에서 특히 본다 |
| `fulfillment_lag_ms` | 주문 생성 → 조리 목록 반영까지의 지연 |
| `fulfillment_empty` | 조리 목록이 비어 준비완료를 못한 횟수 (위 1번 참고) |
| `idempotency_ok` | 멱등성 검증 통과율. 1.0 이어야 한다 |
| `duplicate_orders` | 주문 중복 생성 의심 건수. 0 이어야 한다 |
| `table_blocked` | 테이블이 아직 해제되지 않아 매장 주문이 막힌 횟수 |

`http_req_duration` 은 반드시 `{name:...}` 태그로 끊어서 본다.
태그 없이 전체 p95 를 보면 조회와 쓰기가 섞여 의미가 없다.

## 데이터 정리

회차가 끝나면 문서 3.3.3 절차를 따른다. 특히 Redis 멱등키는 매번 지운다.

```bash
redis-cli --scan --pattern "*${RUN_ID}-*" | xargs -r redis-cli DEL
```

`FLUSHALL` 은 쓰지 않는다. 다른 작업의 데이터까지 삭제된다.
