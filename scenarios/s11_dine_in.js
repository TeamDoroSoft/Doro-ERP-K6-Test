// DINE_IN 전용 검증. 기본 혼합 부하와 분리해 테이블 예약/해제 지연만 본다.
// 결제 승인이나 Toss confirm/cancel은 호출하지 않는다.
import { sleep } from 'k6';
import { thresholds } from '../config/thresholds.js';
import { ensureStaff } from '../lib/auth.js';
import { loadFixtures, tableForVU } from '../lib/setupData.js';
import { buildOrder, createDineInOrder, cancelOrder } from '../lib/api.js';
import { json, okCheck, pickN, randInt } from '../lib/http.js';

export const options = {
  scenarios: {
    dine_in: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 1 },
        { duration: '3m', target: 3 },
        { duration: '3m', target: 5 },
        { duration: '3m', target: 10 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: thresholds(),
};

export function setup() {
  return loadFixtures(true);
}

export default function (data) {
  ensureStaff();
  const body = buildOrder('POS', 'DINE_IN', pickN(data.productIds, randInt(1, 3)), tableForVU(data));
  const res = createDineInOrder(body);
  if (res.status === 503) {
    // Expected while the release scheduler is draining the prior reservation.
    sleep(35);
    return;
  }
  if (!okCheck(res, 'DINE_IN 주문 생성', [201])) return;
  const order = json(res);
  if (order && order.orderId) okCheck(cancelOrder(order.orderId), 'DINE_IN 주문 취소', [200]);
  // Current Prod setting may hold the table for up to 30 seconds.
  sleep(35);
}
