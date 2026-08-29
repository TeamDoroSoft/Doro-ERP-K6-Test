// 시나리오 6. 멱등성 및 동시 요청
//   처리량이 아니라 정확성을 본다. 낮은 부하로 실행한다.
//
//   유형 1: 같은 본문 + 같은 키를 http.batch() 로 동시에 5회
//           → VU 는 순차 실행이므로 반복문으로는 진짜 동시 요청이 안 만들어진다.
//   유형 2: 최초 성공 후 같은 키로 재전송 → 원본 201 재생
//   유형 3: 같은 키 + 다른 본문 → 409 (의도된 오류)
//   유형 4: 같은 내용 + 다른 키 → 각각 정상 처리
//
//   k6 run -e BASE_URL=... -e RUN_ID=LOADTEST-007 scenarios/s6_idempotency.js

import http from 'k6/http';
import { check, sleep } from 'k6';
import { thresholds } from '../config/thresholds.js';
import { SMOKE } from '../config/env.js';
import { url, json, okCheck, pickN, randInt, idemKey, requestId, TAG, OK, OK_OR_CONFLICT } from '../lib/http.js';
import { ensureStaff, writeHeaders } from '../lib/auth.js';
import { buildOrder, createOrder, createEntry } from '../lib/api.js';
import { loadFixtures } from '../lib/setupData.js';
import { idemOk, duplicateOrders, expectedErrors } from '../lib/metrics.js';

export const options = {
  scenarios: {
    idempotency: {
      executor: 'constant-vus',
      vus: SMOKE ? 1 : 10,
      duration: SMOKE ? '30s' : '5m',
    },
  },
  thresholds: Object.assign(thresholds(), {
    idempotency_ok: ['rate>0.99'],
    duplicate_orders: ['count==0'],
  }),
};

export function setup() {
  return loadFixtures();
}

export default function (data) {
  ensureStaff();
  const type = (__ITER % 4) + 1;

  if (type === 1) concurrentSameKey(data);
  else if (type === 2) replaySameKey(data);
  else if (type === 3) sameKeyDifferentBody(data);
  else differentKeys(data);

  sleep(randInt(1, 2));
}

// 멱등성만 보는 시나리오다. 테이블 경합이 끼면 결과 해석이 어려워지므로 TAKEOUT 고정.
function orderBody(data, quantityBump) {
  const products = pickN(data.productIds, 2);
  const body = buildOrder('POS', 'TAKEOUT', products);
  if (quantityBump) body.lines[0].quantity = body.lines[0].quantity + 1;
  return body;
}

// 유형 1 — 진짜 동시 전송
function concurrentSameKey(data) {
  const key = idemKey('idem-batch');
  const body = JSON.stringify(orderBody(data));
  const baseHeaders = writeHeaders({ 'Content-Type': 'application/json', 'Idempotency-Key': key });
  const params = {
    headers: baseHeaders,
    tags: { name: TAG.orderCreate },
    responseCallback: OK_OR_CONFLICT,
  };

  const reqs = [];
  for (let i = 0; i < 5; i++) {
    reqs.push(['POST', url('/api/v1/orders'), body, Object.assign({}, params, {
      headers: Object.assign({}, baseHeaders, { 'X-Request-Id': requestId() }),
    })]);
  }
  const responses = http.batch(reqs);

  // 성공 응답들의 orderId 가 모두 같아야 한다.
  // 처리 중 충돌(409)은 계약상 허용된다.
  const ids = {};
  let created = 0;
  let conflict = 0;
  for (const r of responses) {
    if (r.status === 201 || r.status === 200) {
      const o = json(r);
      if (o && o.orderId) { ids[o.orderId] = true; created++; }
    } else if (r.status === 409) {
      conflict++;
      expectedErrors.add(1, { case: 'idem_in_progress' });
    }
  }
  const unique = Object.keys(ids).length;
  const pass = created >= 1 && unique === 1;
  if (unique > 1) duplicateOrders.add(unique - 1);
  idemOk.add(pass);
  check(null, {
    '동시 5회 → 주문 1건만 생성': () => pass,
    '응답이 모두 처리됨': () => created + conflict === 5,
  });
}

// 유형 2 — 최초 성공 후 같은 키로 재전송
function replaySameKey(data) {
  const key = idemKey('idem-replay');
  const body = orderBody(data);

  const first = createOrder(body, key);
  if (!okCheck(first, '멱등 최초 요청', [201])) { idemOk.add(false); return; }
  const a = json(first);

  const second = createOrder(body, key);
  const b = json(second);
  const same = !!(a && b && a.orderId === b.orderId);
  if (b && a && b.orderId !== a.orderId) duplicateOrders.add(1);
  idemOk.add(same);
  check(null, { '같은 키 재전송 → 같은 주문 반환': () => same });
}

// 유형 3 — 같은 키 + 다른 본문 → 409
function sameKeyDifferentBody(data) {
  const key = idemKey('idem-conflict');
  const first = createOrder(orderBody(data), key);
  if (!okCheck(first, '멱등 최초 요청', [201])) { idemOk.add(false); return; }

  const second = createOrder(orderBody(data, true), key, OK_OR_CONFLICT);
  const isConflict = second.status === 409;
  if (isConflict) expectedErrors.add(1, { case: 'idem_key_reused' });
  idemOk.add(isConflict);
  check(second, { '같은 키 + 다른 본문 → 409': (r) => r.status === 409 });
}

// 유형 4 — 다른 키는 각각 별개
function differentKeys(data) {
  const body = orderBody(data);
  const r1 = createOrder(body, idemKey('idem-diff-a'));
  const r2 = createOrder(body, idemKey('idem-diff-b'));
  const o1 = json(r1);
  const o2 = json(r2);
  const distinct = !!(o1 && o2 && o1.orderId && o2.orderId && o1.orderId !== o2.orderId);
  idemOk.add(distinct);
  check(null, { '다른 키 → 주문 2건 생성': () => distinct });

  // 대기 등록도 같은 규칙인지 확인
  const e1 = createEntry(2, idemKey('idem-entry-a'), OK);
  const e2 = createEntry(2, idemKey('idem-entry-a2'), OK);
  const q1 = json(e1);
  const q2 = json(e2);
  check(null, {
    '대기 다른 키 → 2건 생성': () => !!(q1 && q2 && q1.entryId !== q2.entryId),
  });
}
