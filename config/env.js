// 실행 환경 설정. 모든 값은 -e 옵션으로 덮어쓸 수 있다.
//   k6 run -e BASE_URL=https://... -e RUN_ID=LOADTEST-007 scenarios/s2_pos_order.js

function num(name, def) {
  const v = __ENV[name];
  return v === undefined || v === '' ? def : Number(v);
}
function str(name, def) {
  const v = __ENV[name];
  return v === undefined || v === '' ? def : v;
}

export const BASE_URL = str('BASE_URL', 'http://localhost:8080').replace(/\/+$/, '');

// 회차 식별자. 멱등키 접두사와 시드 데이터 이름에 쓰인다.
export const RUN_ID = str('RUN_ID', 'LOADTEST-LOCAL');

// 테스트 대상 업체 / 계정
export const TENANT_CODE = str('TENANT_CODE', RUN_ID.toLowerCase());
export const OWNER_ID = str('OWNER_ID', 'owner01');
export const OWNER_PW = str('OWNER_PW', 'Doro!Test1234');
// 직원 계정은 staff001 ~ staffNNN 형태로 시드된다.
export const STAFF_PREFIX = str('STAFF_PREFIX', 'staff');
export const STAFF_PW = str('STAFF_PW', 'Doro!Test1234');
export const STAFF_COUNT = num('STAFF_COUNT', 500);

// 키오스크 기기. 시드 단계에서 device001 ~ deviceNNN 로 등록해 둔다.
export const KIOSK_PREFIX = str('KIOSK_PREFIX', 'device');
export const KIOSK_SECRET = str('KIOSK_SECRET', 'doro-kiosk-secret');
export const KIOSK_COUNT = num('KIOSK_COUNT', 200);

// ---------------------------------------------------------------------------
// 부하 기준값 (문서 0장 / 4장)
//   팀 협의 목표치. 실측 후 조정한다.
// ---------------------------------------------------------------------------
export const LOAD = {
  normal: num('VU_NORMAL', 100), // 정상
  peak: num('VU_PEAK', 300),     // 피크
  limit: num('VU_LIMIT', 500),   // 한계 확인
};

// 열린 모델(초당 요청) 기준값. 동시 사용자 기준값에서 환산한 근사치.
// 사용자 1명이 대략 6초에 1회 요청한다고 보고 VU / 6 으로 잡았다.
export const RATE = {
  normal: num('RPS_NORMAL', Math.round(LOAD.normal / 6)),
  peak: num('RPS_PEAK', Math.round(LOAD.peak / 6)),
  limit: num('RPS_LIMIT', Math.round(LOAD.limit / 6)),
};

// 스모크 모드: 모든 시나리오를 1 VU / 30초로 축소 실행한다.
export const SMOKE = str('SMOKE', '') === '1';

// ---------------------------------------------------------------------------
// 매장 주문(DINE_IN) 비율.
//   기본값 0 = 매장 주문을 아예 만들지 않는다 (전부 포장).
//
//   이유: 테이블은 한 번에 주문 1건만 받고, 주문을 끝내도 해제가 최대 30초 걸린다.
//   즉 테이블 수와 해제 주기가 처리량의 상한을 만든다. 이 상태로 섞어 돌리면
//   서버 성능이 아니라 테이블 회전율을 재게 된다.
//
//   테이블 해제 지연이 해결된 뒤, 또는 매장 주문 경로를 따로 검증할 때만 켠다.
//     -e DINE_IN_RATIO=0.15
export const DINE_IN_RATIO = num('DINE_IN_RATIO', 0);

// 매장 주문을 켤 때, 테이블 하나가 다시 쓸 수 있게 되기까지의 시간(초).
// 필요한 테이블 수 = 초당 매장 주문 수 x 이 값 x 1.5
export const TABLE_RELEASE_SECONDS = num('TABLE_RELEASE_SECONDS', 35);

export function wantDineIn() {
  return DINE_IN_RATIO > 0 && Math.random() < DINE_IN_RATIO;
}

export const BUSINESS_DATE = str('BUSINESS_DATE', new Date().toISOString().slice(0, 10));

export function log(msg) {
  if (str('VERBOSE', '') === '1') console.log(`[${RUN_ID}] ${msg}`);
}
