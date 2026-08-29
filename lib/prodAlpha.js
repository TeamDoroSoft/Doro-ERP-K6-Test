// ---------------------------------------------------------------------------
// Prod Alpha 부하테스트 공통 로직
//   문서: prodalphaloadtestscenario.md
//
//   단일 실행 workload 비율 (완료 업무 흐름 기준)
//     POS   TAKEOUT 주문                 25%
//     Kiosk TAKEOUT 주문                 25%
//     POS   DINE_IN 주문 + 후불 결제     20%
//     Kiosk DINE_IN 주문 + 후불 결제     15%
//     대기열 등록·조회·상태 변경         10%
//     주문 상세·상태 확인 / 운영 조회     5%
//
//   조회(메뉴·상품·테이블)는 별도 비율로 세지 않는다. 각 업무 흐름의 준비
//   단계로 포함되며, 서버 지표에는 그대로 기록된다. (문서 3장)
//
//   직원 세션(SESSION)과 키오스크 세션(DORO_KIOSK_DEVICE)을 한 VU 에 섞으면
//   401 AMBIGUOUS_AUTHENTICATION 이 나므로 executor 를 둘로 나눈다.
//     직원  몫 = 25 + 20 + 10 + 5 = 60%
//     키오스크 몫 = 25 + 15        = 40%
// ---------------------------------------------------------------------------

import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import {
  get, post, json, okCheck, idemKey, pickN, randInt,
  OK, OK_OR_CONFLICT, OK_OR_UNAVAILABLE,
} from './http.js';
import { ensureStaff, ensureKiosk, handleAuthLoss, writeHeaders } from './auth.js';
import { tableBlocked, expectedErrors } from './metrics.js';
import { BUSINESS_DATE } from '../config/env.js';

// ---------------------------------------------------------------------------
// name tag (문서 8장)
// ---------------------------------------------------------------------------
export const T = {
  menuList: 'menu_list',
  productDetail: 'product_detail',
  tableList: 'table_list',
  orderList: 'order_list',
  posTakeout: 'pos_takeout_order',
  kioskTakeout: 'kiosk_takeout_order',
  posDineIn: 'pos_dinein_order',
  kioskDineIn: 'kiosk_dinein_order',
  orderDetail: 'order_detail',
  orderStatus: 'order_status',
  queueRegister: 'queue_register',
  queueStatus: 'queue_status',
  queueTransition: 'queue_transition',
  tablePostpay: 'table_postpay',
};

// ---------------------------------------------------------------------------
// 커스텀 지표
// ---------------------------------------------------------------------------
// table_blocked / expected_errors 는 lib/metrics.js 의 것을 그대로 쓴다 (중복 등록 방지)
export const flowCount = new Counter('business_flow');          // 흐름별 실행 수
export const postpayPending = new Counter('postpay_pending');   // PENDING 생성 성공
export const orderToStatusMs = new Trend('order_to_status_ms', true);

// 후불 결제 단계 on/off. confirm/cancel 은 어떤 경우에도 호출하지 않는다.
const POSTPAY = String(__ENV.POSTPAY || '1') === '1';

// ---------------------------------------------------------------------------
// API 래퍼 — 문서 8장의 name tag 를 그대로 붙인다
// ---------------------------------------------------------------------------
function getMenu() { return get('/api/v1/catalog/menu', T.menuList); }
function getProducts() { return get('/api/v1/catalog/products', T.productDetail); }
function getTables() { return get('/api/v1/tables', T.tableList); }
function getOrders() { return get(`/api/v1/orders?businessDate=${BUSINESS_DATE}`, T.orderList); }

function orderBody(channel, serviceType, productIds, tableId) {
  const lines = productIds.map((id) => ({ productId: id, quantity: randInt(1, 3) }));
  const body = { orderChannel: channel, serviceType: serviceType, lines: lines };
  if (serviceType === 'DINE_IN') body.tableId = tableId;
  return body;
}

function createOrder(body, tag, dineIn) {
  return post('/api/v1/orders', body, tag, {
    headers: writeHeaders({ 'Idempotency-Key': idemKey('order') }),
    responseCallback: dineIn ? OK_OR_UNAVAILABLE : OK,
  });
}

function orderDetail(orderId, tag, accessToken) {
  const extra = {};
  if (accessToken) extra.headers = { 'X-Order-Access-Token': accessToken };
  return get(`/api/v1/orders/${orderId}`, tag, extra);
}

// 후불 결제: PENDING 결제만 생성한다.
//   POST /api/v1/payments 는 { orderId } 만 받고 PENDING 스냅샷을 돌려준다.
//   외부 PG 승인은 confirm(paymentKey 필요) 단계이며 여기서 호출하지 않는다. (문서 6장)
function createPostpay(orderId) {
  return post('/api/v1/payments', { orderId: orderId }, T.tablePostpay, {
    headers: writeHeaders({ 'Idempotency-Key': idemKey('postpay') }),
    responseCallback: OK_OR_CONFLICT,
  });
}

// ---------------------------------------------------------------------------
// 테이블 배분 (문서 5장 — 같은 테이블을 여러 VU 가 동시에 선택하지 않게)
//   VU 마다 겹치지 않는 블록을 주고, 블록 안에서 iteration 마다 돌려 쓴다.
//   테이블 해제가 최대 30초 걸리므로 같은 테이블 재사용 간격을 벌리는 것이 핵심이다.
// ---------------------------------------------------------------------------
const MAX_VU = Number(__ENV.VU_TOTAL || 100);

export function tableForVU(tableIds) {
  if (!tableIds || tableIds.length === 0) return null;
  const n = tableIds.length;
  const block = Math.max(1, Math.floor(n / MAX_VU));
  const base = ((__VU - 1) % MAX_VU) * block;
  return tableIds[(base + (__ITER % block)) % n];
}

export function warnIfTablesShort(tableIds) {
  const need = Math.ceil(MAX_VU * 0.35 * 1.5);   // DINE_IN 35% + 여유
  const have = tableIds ? tableIds.length : 0;
  if (have < need * 2) {
    console.warn(
      `[경고] 활성 테이블 ${have}개. DINE_IN 35% / VU ${MAX_VU} 기준 최소 ${need * 2}개 권장. ` +
      '부족하면 테이블 해제(최대 30초) 때문에 503 이 늘어나고 서버 성능이 아니라 테이블 회전율을 재게 됩니다.'
    );
  }
}

// ---------------------------------------------------------------------------
// 준비 조회 단계 (문서 4.1)
// ---------------------------------------------------------------------------
function browseForOrder(needTable) {
  okCheck(getMenu(), '메뉴 조회', [200]);
  if (Math.random() < 0.5) okCheck(getProducts(), '상품 조회', [200]);
  if (needTable) okCheck(getTables(), '테이블 조회', [200]);
}

// 주문 생성 후 상세/상태 확인까지. 생성된 주문 id 를 돌려준다.
function afterOrder(res, accessToken) {
  const o = json(res);
  if (!o || !o.orderId) return null;
  const t0 = Date.now();
  okCheck(orderDetail(o.orderId, T.orderDetail, accessToken), '주문 상세', [200]);
  sleep(randInt(1, 2));
  okCheck(orderDetail(o.orderId, T.orderStatus, accessToken), '주문 상태', [200]);
  orderToStatusMs.add(Date.now() - t0);
  return o;
}

// ---------------------------------------------------------------------------
// 4.2 POS TAKEOUT — 전체 25%
// ---------------------------------------------------------------------------
function posTakeout(data) {
  flowCount.add(1, { flow: 'pos_takeout' });
  browseForOrder(false);

  const body = orderBody('POS', 'TAKEOUT', pickN(data.productIds, randInt(1, 4)));
  let res = createOrder(body, T.posTakeout, false);
  if (handleAuthLoss(res)) res = createOrder(body, T.posTakeout, false);
  if (!okCheck(res, 'POS 포장 주문', [201])) return;

  const o = afterOrder(res);
  if (o) remember(o.orderId);
}

// ---------------------------------------------------------------------------
// 4.4 POS DINE_IN + 후불 결제 — 전체 20%
// ---------------------------------------------------------------------------
function posDineIn(data) {
  flowCount.add(1, { flow: 'pos_dinein' });
  browseForOrder(true);

  const tableId = tableForVU(data.tableIds);
  if (!tableId) return;

  const body = orderBody('POS', 'DINE_IN', pickN(data.productIds, randInt(1, 4)), tableId);
  let res = createOrder(body, T.posDineIn, true);
  if (handleAuthLoss(res)) res = createOrder(body, T.posDineIn, true);

  // 테이블이 아직 해제되지 않음. 서버 장애가 아니므로 실패로 세지 않는다.
  if (res.status === 503) { tableBlocked.add(1, { channel: 'POS' }); return; }
  if (!okCheck(res, 'POS 매장 주문', [201])) return;

  const o = afterOrder(res);
  if (!o) return;
  remember(o.orderId);

  if (POSTPAY) {
    const pay = createPostpay(o.orderId);
    if (pay.status === 409) expectedErrors.add(1, { case: 'postpay_conflict' });
    if (okCheck(pay, '후불 결제 생성', [201, 409]) && pay.status === 201) {
      postpayPending.add(1, { channel: 'POS' });
    }
  }
}

// ---------------------------------------------------------------------------
// 4.7 대기열 — 전체 10%
// ---------------------------------------------------------------------------
function queueFlow() {
  flowCount.add(1, { flow: 'queue' });
  const what = Math.random();

  if (what < 0.5) {
    // 등록 후 자기 항목만 전이시킨다 (문서 5장 — 데이터 소유권 분리)
    const res = post('/api/v1/queues/entry', {
      businessDate: BUSINESS_DATE,
      partySize: randInt(1, 6),
    }, T.queueRegister, {
      headers: writeHeaders({ 'Idempotency-Key': idemKey('entry') }),
    });
    if (!okCheck(res, '대기 등록', [201])) return;

    const e = json(res);
    if (!e || !e.entryId) return;
    sleep(randInt(1, 2));

    const action = ['enter', 'cancel', 'no-show'][randInt(0, 2)];
    const t = post(`/api/v1/queues/entry/${e.entryId}/${action}`, null, T.queueTransition, {
      headers: writeHeaders({}),
      responseCallback: OK_OR_CONFLICT,
      tags: { action: action },
    });
    if (t.status === 409) expectedErrors.add(1, { case: 'entry_state_conflict' });
    okCheck(t, `대기 ${action}`, [200, 409]);
  } else {
    okCheck(get(`/api/v1/queues/entry?businessDate=${BUSINESS_DATE}`, T.queueStatus), '대기 목록', [200]);
  }
}

// ---------------------------------------------------------------------------
// 4.6 주문 상세·상태 확인 / 직원 운영 조회 — 전체 5%
//   존재하지 않는 주문 id 를 무작위로 만들지 않는다. 404 는 성공으로 세지 않는다.
// ---------------------------------------------------------------------------
function inspectFlow() {
  flowCount.add(1, { flow: 'inspect' });
  okCheck(getOrders(), '주문 목록', [200]);

  const id = takeRecent();
  if (!id) return;
  sleep(randInt(1, 2));
  okCheck(orderDetail(id, T.orderDetail), '주문 상세', [200]);
  okCheck(orderDetail(id, T.orderStatus), '주문 상태', [200]);
}

// ---------------------------------------------------------------------------
// 4.3 Kiosk TAKEOUT — 전체 25%
// 4.5 Kiosk DINE_IN + 후불 결제 — 전체 15%
// ---------------------------------------------------------------------------
function kioskTakeout(data) {
  flowCount.add(1, { flow: 'kiosk_takeout' });
  browseForOrder(false);

  const body = orderBody('KIOSK', 'TAKEOUT', pickN(data.productIds, randInt(1, 4)));
  let res = createOrder(body, T.kioskTakeout, false);
  if (handleAuthLoss(res)) res = createOrder(body, T.kioskTakeout, false);
  if (!okCheck(res, '키오스크 포장 주문', [201])) return;

  const o = json(res);
  if (o && o.orderId) afterOrder(res, o.orderAccessToken);
}

function kioskDineIn(data) {
  flowCount.add(1, { flow: 'kiosk_dinein' });
  browseForOrder(true);

  const tableId = tableForVU(data.tableIds);
  if (!tableId) return;

  const body = orderBody('KIOSK', 'DINE_IN', pickN(data.productIds, randInt(1, 4)), tableId);
  let res = createOrder(body, T.kioskDineIn, true);
  if (handleAuthLoss(res)) res = createOrder(body, T.kioskDineIn, true);

  if (res.status === 503) { tableBlocked.add(1, { channel: 'KIOSK' }); return; }
  if (!okCheck(res, '키오스크 매장 주문', [201])) return;

  const o = json(res);
  if (!o || !o.orderId) return;
  afterOrder(res, o.orderAccessToken);

  if (POSTPAY) {
    const pay = createPostpay(o.orderId);
    if (pay.status === 409) expectedErrors.add(1, { case: 'postpay_conflict' });
    if (okCheck(pay, '후불 결제 생성', [201, 409]) && pay.status === 201) {
      postpayPending.add(1, { channel: 'KIOSK' });
    }
  }
}

// ---------------------------------------------------------------------------
// VU 로컬 최근 주문 큐 (자기가 만든 주문만 후속 조회에 쓴다)
// ---------------------------------------------------------------------------
const recent = [];
function remember(id) { recent.push(id); if (recent.length > 20) recent.shift(); }
function takeRecent() {
  if (recent.length === 0) return null;
  return recent[Math.floor(Math.random() * recent.length)];
}

// ---------------------------------------------------------------------------
// 가중치 선택 (문서 3장 — iteration 시작 시 1회)
// ---------------------------------------------------------------------------

// 직원 몫 60% 를 다시 100% 로 정규화
//   POS TAKEOUT 25/60 = .4167 | POS DINE_IN 20/60 = .3333
//   대기열      10/60 = .1667 | 운영 조회    5/60 = .0833
export function staffIteration(data) {
  ensureStaff();
  const r = Math.random();
  if (r < 0.41667) posTakeout(data);
  else if (r < 0.75000) posDineIn(data);
  else if (r < 0.91667) queueFlow();
  else inspectFlow();
  sleep(randInt(1, 3));
}

// 키오스크 몫 40% 를 다시 100% 로 정규화
//   Kiosk TAKEOUT 25/40 = .625 | Kiosk DINE_IN 15/40 = .375
export function kioskIteration(data) {
  ensureKiosk();
  if (Math.random() < 0.625) kioskTakeout(data);
  else kioskDineIn(data);
  sleep(randInt(1, 3));
}
