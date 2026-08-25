// 시나리오 3. 키오스크 주문 생성 (포장·매장 통합)
//   부하 모델: 닫힌 모델 (ramping-vus) — 키오스크는 대수가 물리적으로 고정된다.
//   TAKEOUT 70% / DINE_IN 30%
//
//   주의: 키오스크 쿠키(DORO_KIOSK_DEVICE)와 직원 세션(SESSION)이 한 VU 에 같이
//         있으면 401 AMBIGUOUS_AUTHENTICATION 이 난다. 이 스크립트는 키오스크만 쓴다.
//   주의: 키오스크는 주문 목록/완료/취소를 호출할 수 없다 (403 ACCESS_DENIED).
//         주문 상세 조회는 X-Order-Access-Token 헤더가 필요하다.
//
//   k6 run -e BASE_URL=... -e RUN_ID=LOADTEST-007 scenarios/s3_kiosk_order.js

import { sleep, check } from 'k6';
import { thresholds } from '../config/thresholds.js';
import { LOAD, SMOKE, DINE_IN_RATIO, wantDineIn } from '../config/env.js';
import { json, okCheck, pickN, randInt } from '../lib/http.js';
import { ensureKiosk } from '../lib/auth.js';
import { buildOrder, createOrder, createDineInOrder, getOrder, getMenu, productIdsFrom, listTables, tableIdsFrom } from '../lib/api.js';
import { fail } from 'k6';

export const options = {
  scenarios: {
    kiosk_order: SMOKE
      ? { executor: 'constant-vus', vus: 1, duration: '30s' }
      : {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: [
            { duration: '30s', target: Math.round(LOAD.normal / 3) },
            { duration: '5m', target: Math.round(LOAD.normal / 3) },
            { duration: '30s', target: LOAD.normal },
            { duration: '5m', target: LOAD.normal },
            { duration: '30s', target: 0 },
          ],
          gracefulRampDown: '30s',
        },
  },
  thresholds: thresholds(),
};

// 키오스크 인증으로도 메뉴·테이블을 조회할 수 있으므로 setup 에서 키오스크로 받아둔다.
export function setup() {
  // setup 은 자체 쿠키 jar 를 쓴다. 여기서 활성화해도 VU 로 전달되지 않는다.
  ensureKiosk();
  const menu = getMenu();
  if (menu.status !== 200) fail(`메뉴 조회 실패 ${menu.status}`);
  const productIds = productIdsFrom(menu);
  if (productIds.length === 0) fail('판매 상품이 없습니다. 시드를 먼저 실행하세요.');

  let tableIds = [];
  if (DINE_IN_RATIO > 0) {
    const tables = listTables();
    tableIds = tables.status === 200 ? tableIdsFrom(tables) : [];
    if (tableIds.length === 0) console.warn('[경고] 활성 테이블이 없어 매장 주문을 건너뜁니다.');
  }
  return { productIds: productIds, tableIds: tableIds };
}

export default function (data) {
  ensureKiosk();

  const products = pickN(data.productIds, randInt(1, 4));
  // 기본은 전부 TAKEOUT. 테이블이 처리량 상한을 만들기 때문이다. (env.js 참고)
  const dineIn = data.tableIds.length > 0 && wantDineIn();
  const body = dineIn
    ? buildOrder('KIOSK', 'DINE_IN', products, data.tableIds[(((__VU - 1) * 31) + (__ITER * 17)) % data.tableIds.length])
    : buildOrder('KIOSK', 'TAKEOUT', products);

  const res = dineIn ? createDineInOrder(body) : createOrder(body);
  const created = okCheck(res, '키오스크 주문 생성', [201]);
  if (!created) {
    sleep(randInt(30, 90));
    return;
  }

  const order = json(res);
  check(order, {
    '주문 접근 토큰 발급됨': (o) => o && typeof o.orderAccessToken === 'string' && o.orderAccessToken.length > 0,
  });
  if (!order || !order.orderId) {
    sleep(randInt(30, 90));
    return;
  }

  // 주문 상태를 3~5초 간격으로 조회. 완료 또는 90초 도달 시 종료.
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    sleep(randInt(3, 5));
    const detail = getOrder(order.orderId, order.orderAccessToken);
    okCheck(detail, '키오스크 주문 상태', [200]);
    const d = json(detail);
    if (d && (d.status === 'COMPLETED' || d.status === 'CANCELLED')) break;
  }

  // 다음 손님까지 대기
  sleep(randInt(30, 90));
}
