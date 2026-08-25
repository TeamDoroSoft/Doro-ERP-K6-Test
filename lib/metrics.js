import { Counter, Trend, Rate } from 'k6/metrics';

// 의도된 오류 (문서 규칙 4). 실패율과 분리해서 센다.
export const expectedErrors = new Counter('expected_errors');

// 재로그인 발생 횟수 (문서 규칙 2)
export const reloginCount = new Counter('relogin_count');

// 주문 생성 → 조리 목록 반영까지의 지연 (문서 시나리오 5)
export const fulfillmentLag = new Trend('fulfillment_lag_ms', true);

// 조리 목록이 비어 있어 준비완료 처리를 못한 횟수.
// 조리 항목은 OrderAccepted 이벤트로 생성되므로, 결제 승인 흐름이 없으면 계속 0건일 수 있다.
export const fulfillmentEmpty = new Counter('fulfillment_empty');

// 멱등성 검증 결과 (문서 시나리오 6)
export const idemOk = new Rate('idempotency_ok');

// 주문 중복 생성 의심 건수
export const duplicateOrders = new Counter('duplicate_orders');

// 테이블이 아직 해제되지 않아 매장 주문이 막힌 횟수.
// 서버 결함이 아니라 테이블 회전율의 구조적 상한을 뜻한다.
export const tableBlocked = new Counter('table_blocked');
