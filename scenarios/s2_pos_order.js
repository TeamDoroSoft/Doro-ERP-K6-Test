// 시나리오 2. POS 주문 생성 (포장·매장 통합)
//   부하 모델: 열린 모델 (ramping-arrival-rate)
//   TAKEOUT 60% / DINE_IN 40%
//
//   k6 run -e BASE_URL=... -e RUN_ID=LOADTEST-007 scenarios/s2_pos_order.js

import { check } from 'k6';
import { thresholds } from '../config/thresholds.js';
import { RATE, LOAD, SMOKE, DINE_IN_RATIO, wantDineIn } from '../config/env.js';
import { json, okCheck, pickN, randInt } from '../lib/http.js';
import { ensureStaff, handleAuthLoss } from '../lib/auth.js';
import { buildOrder, createOrder, createDineInOrder, getOrder, listOrders } from '../lib/api.js';
import { loadFixtures, tableForVU, assertEnoughTables } from '../lib/setupData.js';

const MAX_VU = LOAD.peak;

export const options = {
  scenarios: {
    pos_order: SMOKE
      ? { executor: 'constant-arrival-rate', rate: 1, timeUnit: '1s', duration: '30s', preAllocatedVUs: 5 }
      : {
          executor: 'ramping-arrival-rate',
          startRate: 1,
          timeUnit: '1s',
          preAllocatedVUs: Math.max(20, Math.round(MAX_VU / 3)),
          maxVUs: MAX_VU,
          stages: [
            { duration: '1m', target: RATE.normal },
            { duration: '5m', target: RATE.normal },
            { duration: '1m', target: RATE.peak },
            { duration: '5m', target: RATE.peak },
            { duration: '30s', target: 0 },
          ],
        },
  },
  thresholds: thresholds(),
};

export function setup() {
  const data = loadFixtures();
  assertEnoughTables(data, RATE.peak * DINE_IN_RATIO);
  return data;
}

export default function (data) {
  ensureStaff();

  // 3) 상품 1~4개 무작위 선택
  const products = pickN(data.productIds, randInt(1, 4));

  // 4) 유형 결정
  //    기본은 전부 TAKEOUT. DINE_IN_RATIO 를 켜야 매장 주문이 섞인다.
  //    테이블이 처리량 상한을 만들기 때문에 기본값에서는 제외한다. (env.js 참고)
  const dineIn = wantDineIn();
  const body = dineIn
    ? buildOrder('POS', 'DINE_IN', products, tableForVU(data))
    : buildOrder('POS', 'TAKEOUT', products);

  // 5) 주문 생성
  let res = dineIn ? createDineInOrder(body) : createOrder(body);
  if (handleAuthLoss(res)) res = dineIn ? createDineInOrder(body) : createOrder(body);

  // 매장 주문이 테이블 때문에 막힌 경우(503)는 여기서 끝낸다 (table_blocked 로 집계됨)
  if (dineIn && res.status === 503) return;

  const created = okCheck(res, '주문 생성', [201]);
  if (!created) return;

  const order = json(res);
  check(order, {
    '주문번호 발급됨': (o) => o && typeof o.displayNumber === 'number' && o.displayNumber >= 1,
    '금액 1원 이상': (o) => o && o.totalAmount >= 1,
    '통화 KRW': (o) => o && o.currency === 'KRW',
    '상태 CREATED': (o) => o && o.status === 'CREATED',
  });
  if (!order || !order.orderId) return;

  // 6) 생성 직후 상세 조회 — 읽기 지연 확인
  const detail = getOrder(order.orderId);
  okCheck(detail, '주문 상세', [200]);
  const d = json(detail);
  check(d, {
    '상세 금액 일치': (x) => x && x.totalAmount === order.totalAmount,
  });

  // 7) 20% 확률로 목록 조회
  if (Math.random() < 0.2) {
    okCheck(listOrders(data.businessDate), '주문 목록', [200]);
  }
}
