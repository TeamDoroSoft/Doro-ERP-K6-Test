// 실제 영업 혼합 부하의 요청 비율 (문서 시나리오 7)
//   조회 45% / POS 주문 20% / 키오스크 주문 20% / 상태·상세 조회 10% / 상태 변경 5%
//
// 키오스크와 직원 세션은 한 VU 에 섞을 수 없으므로(AMBIGUOUS_AUTHENTICATION)
// 키오스크 주문은 별도 exec 함수로 분리한다. 이 파일은 직원 쪽 80% 를 담당한다.

import { sleep } from 'k6';
import { json, okCheck, pickN, randInt, pick } from './http.js';
import { ensureStaff, handleAuthLoss } from './auth.js';
import {
  getMenu, listOrders, listTables, listFulfillment,
  buildOrder, createOrder, createDineInOrder, getOrder,
  createEntry, listEntries, transitionEntry,
  markReady,
} from './api.js';
import { tableForVU } from './setupData.js';
import { wantDineIn } from '../config/env.js';
import { expectedErrors } from './metrics.js';

// 직원 VU 가 도는 흐름. 전체 100% 중 직원 몫 80% 를 다시 정규화한 비율.
//   조회 45 → 56.25%, POS 주문 20 → 25%, 상세 10 → 12.5%, 상태변경 5 → 6.25%
export function staffMixedIteration(data) {
  ensureStaff();
  const r = Math.random();

  if (r < 0.5625) {
    browse(data);
  } else if (r < 0.8125) {
    placeOrder(data);
  } else if (r < 0.9375) {
    inspect(data);
  } else {
    changeState(data);
  }

  sleep(randInt(1, 3));
}

function browse(data) {
  const which = pick(['orders', 'fulfillment', 'entries', 'menu', 'tables']);
  if (which === 'orders') okCheck(listOrders(data.businessDate), '주문 목록', [200]);
  else if (which === 'fulfillment') okCheck(listFulfillment(), '조리 목록', [200]);
  else if (which === 'entries') okCheck(listEntries(data.businessDate), '대기 목록', [200]);
  else if (which === 'menu') okCheck(getMenu(), '메뉴', [200]);
  else okCheck(listTables(), '테이블', [200]);
}

function placeOrder(data) {
  const products = pickN(data.productIds, randInt(1, 4));
  // 기본은 전부 TAKEOUT. DINE_IN_RATIO 를 켜야 매장 주문이 섞인다. (env.js 참고)
  const dineIn = wantDineIn();
  const body = dineIn
    ? buildOrder('POS', 'DINE_IN', products, tableForVU(data))
    : buildOrder('POS', 'TAKEOUT', products);

  let res = dineIn ? createDineInOrder(body) : createOrder(body);
  if (handleAuthLoss(res)) res = dineIn ? createDineInOrder(body) : createOrder(body);
  if (dineIn && res.status === 503) return;   // 테이블 대기 — table_blocked 로 집계
  okCheck(res, '주문 생성', [201]);

  const o = json(res);
  if (o && o.orderId) {
    // 방금 만든 주문 id 를 VU 안에 쌓아둔다 (상태 변경 때 자기 것만 건드리기 위해)
    remember(o.orderId);
  }
}

function inspect(data) {
  const id = takeRecent();
  if (!id) {
    okCheck(listOrders(data.businessDate), '주문 목록', [200]);
    return;
  }
  okCheck(getOrder(id), '주문 상세', [200]);
}

function changeState(data) {
  // 대기 등록 후 자기 대기를 전이시킨다. 남의 항목은 건드리지 않는다.
  const res = createEntry(randInt(1, 6));
  if (!okCheck(res, '대기 등록', [201])) return;
  const e = json(res);
  if (!e || !e.entryId) return;

  const action = pick(['enter', 'cancel', 'no-show']);
  const t = transitionEntry(e.entryId, action, true);
  if (t.status === 409) expectedErrors.add(1, { case: 'entry_state_conflict' });
  okCheck(t, `대기 ${action}`, [200, 409]);

  // 조리 목록에 자기 주문이 있으면 준비완료도 섞는다
  const own = takeRecent();
  if (own) {
    const list = listFulfillment();
    if (list.status === 200) {
      const items = json(list) || [];
      const mine = items.filter((it) => it.orderId === own && it.status === 'PREPARING')[0];
      if (mine) okCheck(markReady(mine.fulfillmentId, true), '준비 완료', [200, 409]);
    }
  }
}

// VU 로컬 최근 주문 큐
const recent = [];
function remember(id) {
  recent.push(id);
  if (recent.length > 20) recent.shift();
}
function takeRecent() {
  if (recent.length === 0) return null;
  return recent[Math.floor(Math.random() * recent.length)];
}
