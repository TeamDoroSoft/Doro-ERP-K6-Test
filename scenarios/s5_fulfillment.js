// 시나리오 5. 조리 처리 및 주문 완료
//   부하 모델: 주문 생성·전이는 열린 모델, 조리 목록 조회는 닫힌 모델.
//
//   ⚠ 중요한 전제
//   조리 항목(fulfillment)은 HTTP 로 생성되지 않는다. OrderAccepted 이벤트를
//   소비할 때 PREPARING 으로 자동 생성된다. 즉 주문을 만들기만 해서는 조리 목록이
//   채워지지 않을 수 있다(결제 승인 흐름이 선행돼야 하는 구조).
//   조리 목록이 계속 비면 fulfillment_empty 카운터가 올라간다. 그 경우
//   이 시나리오는 "주문 생성 → 완료/취소"까지만 검증한 것으로 본다.
//
//   k6 run -e BASE_URL=... -e RUN_ID=LOADTEST-007 scenarios/s5_fulfillment.js

import { sleep, check } from 'k6';
import { thresholds } from '../config/thresholds.js';
import { RATE, LOAD, SMOKE } from '../config/env.js';
import { json, okCheck, pickN, randInt } from '../lib/http.js';
import { ensureStaff, handleAuthLoss } from '../lib/auth.js';
import {
  buildOrder, createOrder, getOrder,
  listFulfillment, markReady, completeOrder, cancelOrder,
} from '../lib/api.js';
import { loadFixtures } from '../lib/setupData.js';
import { fulfillmentLag, fulfillmentEmpty, expectedErrors } from '../lib/metrics.js';

const DUR = SMOKE ? '30s' : '10m';
const cooks = SMOKE ? 1 : Math.round(LOAD.normal / 10);

export const options = {
  scenarios: {
    order_feed: SMOKE
      ? { executor: 'constant-arrival-rate', rate: 1, timeUnit: '1s', duration: DUR, preAllocatedVUs: 3, exec: 'orderFlow' }
      : {
          executor: 'constant-arrival-rate',
          rate: Math.max(1, Math.round(RATE.normal / 2)),
          timeUnit: '1s',
          duration: DUR,
          preAllocatedVUs: 20,
          maxVUs: LOAD.peak,
          exec: 'orderFlow',
        },
    kitchen: {
      executor: 'constant-vus',
      vus: cooks,
      duration: DUR,
      exec: 'kitchenFlow',
    },
  },
  thresholds: thresholds(),
};

export function setup() {
  return loadFixtures();
}

// 주문을 만들고, 조리 목록에 뜰 때까지 기다렸다가 준비완료 → 완료/취소까지 처리한다.
export function orderFlow(data) {
  ensureStaff();

  // 조리 흐름 검증이 목적이므로 테이블 경합을 끌어들이지 않는다. 전부 TAKEOUT.
  const products = pickN(data.productIds, randInt(1, 4));
  const body = buildOrder('POS', 'TAKEOUT', products);

  const t0 = Date.now();
  let res = createOrder(body);
  if (handleAuthLoss(res)) res = createOrder(body);
  if (!okCheck(res, '주문 생성', [201])) return;

  const order = json(res);
  if (!order || !order.orderId) return;

  // 자기가 만든 주문이 조리 목록에 뜨는지 확인 (문서 규칙 3 — 남의 항목은 안 건드린다)
  const mine = waitForFulfillment(order.orderId, 15000);
  if (mine) {
    fulfillmentLag.add(Date.now() - t0);
    const ready = markReady(mine.fulfillmentId);
    okCheck(ready, '준비 완료', [200]);

    // 같은 항목을 한 번 더 준비완료 → 중복이 생기지 않아야 한다
    if (Math.random() < 0.1) {
      const again = markReady(mine.fulfillmentId, true);
      if (again.status === 409) expectedErrors.add(1, { case: 'fulfillment_ready_twice' });
      check(again, { '중복 준비완료가 새 데이터를 만들지 않음': (r) => r.status === 200 || r.status === 409 });
    }
  } else {
    fulfillmentEmpty.add(1);
  }

  // 결제/OrderAccepted를 이 시나리오에서 호출하지 않으므로 대부분 CREATED다.
  // CREATED 주문은 완료할 수 없으므로 취소하고, 실제 ACCEPTED만 완료한다.
  const current = getOrder(order.orderId);
  const currentView = json(current);
  if (currentView && currentView.status === 'ACCEPTED' && Math.random() < 0.9) {
    const done = completeOrder(order.orderId);
    okCheck(done, '주문 완료', [200]);
    const d = json(done);
    check(d, { '완료 상태 반영': (x) => x && x.status === 'COMPLETED' });
  } else {
    const cancelled = cancelOrder(order.orderId);
    okCheck(cancelled, '주문 취소', [200]);
    const c = json(cancelled);
    check(c, { '취소 상태 반영': (x) => x && x.status === 'CANCELLED' });
  }

  // 최종 상태 재확인
  const detail = getOrder(order.orderId);
  okCheck(detail, '최종 상태 확인', [200]);
}

function waitForFulfillment(orderId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = listFulfillment();
    if (res.status === 200) {
      const items = json(res) || [];
      for (const it of items) {
        if (it.orderId === orderId && it.status === 'PREPARING') return it;
      }
    }
    sleep(1);
  }
  return null;
}

// 조리 담당자가 조리 목록을 계속 새로고침하는 부하
export function kitchenFlow() {
  ensureStaff({ offset: 2000 });
  okCheck(listFulfillment(), '조리 목록', [200]);
  sleep(randInt(2, 4));
}
