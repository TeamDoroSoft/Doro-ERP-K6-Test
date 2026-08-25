// 혼합 부하 중 키오스크 몫 (전체 20%).
// 직원 세션과 같은 VU 에 섞으면 401 이 나므로 exec 을 분리한다.

import { sleep } from 'k6';
import { json, okCheck, pickN, randInt } from './http.js';
import { ensureKiosk } from './auth.js';
import { buildOrder, createOrder, createDineInOrder, getOrder } from './api.js';
import { wantDineIn } from '../config/env.js';

export function kioskMixedIteration(data) {
  ensureKiosk();

  const products = pickN(data.productIds, randInt(1, 4));
  const dineIn = data.tableIds && data.tableIds.length > 0 && wantDineIn();
  const body = dineIn
    ? buildOrder('KIOSK', 'DINE_IN', products, data.tableIds[(((__VU - 1) * 31) + (__ITER * 17)) % data.tableIds.length])
    : buildOrder('KIOSK', 'TAKEOUT', products);

  const res = dineIn ? createDineInOrder(body) : createOrder(body);
  if (dineIn && res.status === 503) { sleep(randInt(2, 5)); return; }
  if (!okCheck(res, '키오스크 주문', [201])) {
    sleep(randInt(2, 5));
    return;
  }

  const o = json(res);
  if (o && o.orderId) {
    sleep(randInt(3, 5));
    okCheck(getOrder(o.orderId, o.orderAccessToken), '키오스크 주문 상태', [200]);
  }
  sleep(randInt(2, 5));
}
