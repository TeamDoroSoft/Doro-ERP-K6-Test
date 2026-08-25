import { get, post, json, TAG, idemKey, OK, OK_OR_CONFLICT, OK_OR_BAD_REQUEST, OK_OR_UNAVAILABLE } from './http.js';
import { tableBlocked } from './metrics.js';
import { writeHeaders } from './auth.js';
import { BUSINESS_DATE } from '../config/env.js';

// ---------------------------------------------------------------------------
// 응답 봉투 없음. 리소스 객체 / 배열이 그대로 온다.
// 금액은 원 단위 정수, currency 는 "KRW" 고정.
// ---------------------------------------------------------------------------

export function getMenu() {
  return get('/api/v1/catalog/menu', TAG.menu);
}

// 메뉴 응답에서 상품 id 목록을 뽑는다.
// 비활성·품절 상품은 애초에 목록에서 빠지므로 별도 필터가 필요 없다.
export function productIdsFrom(menuRes) {
  const body = json(menuRes);
  if (!body || !body.categories) return [];
  const ids = [];
  for (const c of body.categories) {
    for (const p of c.products || []) ids.push(p.productId);
  }
  return ids;
}

export function listTables() {
  return get('/api/v1/tables', TAG.tableList);
}

// GET /api/v1/tables 는 ACTIVE 인 것만 돌려준다. 필드명은 tableId 가 아니라 id.
export function tableIdsFrom(tableRes) {
  const body = json(tableRes);
  if (!Array.isArray(body)) return [];
  return body.map((t) => t.id);
}

// ---------------------------------------------------------------------------
// 주문
// ---------------------------------------------------------------------------

// channel: 'POS' | 'KIOSK', serviceType: 'DINE_IN' | 'TAKEOUT'
// DINE_IN 은 tableId 필수, TAKEOUT 은 tableId 를 아예 넣지 않는다 (문서 규칙 6).
export function buildOrder(channel, serviceType, productIds, tableId) {
  const lines = productIds.map((id) => ({ productId: id, quantity: 1 + Math.floor(Math.random() * 3) }));
  const body = { orderChannel: channel, serviceType: serviceType, lines: lines };
  if (serviceType === 'DINE_IN') body.tableId = tableId;
  return body;
}

export function createOrder(body, key, responseCallback) {
  return post('/api/v1/orders', body, TAG.orderCreate, {
    headers: writeHeaders({ 'Idempotency-Key': key || idemKey('order') }),
    responseCallback: responseCallback || OK,
  });
}

// 비활성 테이블 등 테이블 정책 위반은 400 VALIDATION_FAILED 로 온다 (409 아님).
export function createOrderExpectingBadRequest(body, key) {
  return createOrder(body, key, OK_OR_BAD_REQUEST);
}

// 같은 키 + 다른 본문은 409 로 온다.
export function createOrderExpectingConflict(body, key) {
  return createOrder(body, key, OK_OR_CONFLICT);
}

// 매장 주문 전용. 테이블이 아직 해제되지 않으면 503 이 온다.
// 서버 장애가 아니므로 실패율에서 빼고 table_blocked 로 따로 센다.
export function createDineInOrder(body, key) {
  const res = createOrder(body, key, OK_OR_UNAVAILABLE);
  if (res.status === 503) tableBlocked.add(1);
  return res;
}

export function getOrder(orderId, accessToken) {
  const extra = {};
  if (accessToken) extra.headers = { 'X-Order-Access-Token': accessToken };
  return get(`/api/v1/orders/${orderId}`, TAG.orderDetail, extra);
}

export function listOrders(businessDate, status) {
  const q = [`businessDate=${businessDate || BUSINESS_DATE}`];
  if (status) q.push(`status=${status}`);
  return get(`/api/v1/orders?${q.join('&')}`, TAG.orderList);
}

// complete / cancel 은 요청 바디가 없다. Idempotency-Key 는 선택.
export function completeOrder(orderId) {
  return post(`/api/v1/orders/${orderId}/complete`, null, TAG.orderComplete, {
    headers: writeHeaders({ 'Idempotency-Key': idemKey('complete') }),
  });
}

export function cancelOrder(orderId) {
  return post(`/api/v1/orders/${orderId}/cancel`, null, TAG.orderCancel, {
    headers: writeHeaders({ 'Idempotency-Key': idemKey('cancel') }),
  });
}

// ---------------------------------------------------------------------------
// 입장 대기
// ---------------------------------------------------------------------------

export function createEntry(partySize, key, responseCallback) {
  return post('/api/v1/queues/entry', {
    businessDate: BUSINESS_DATE,
    partySize: partySize,
  }, TAG.entryCreate, {
    headers: writeHeaders({ 'Idempotency-Key': key || idemKey('entry') }),
    responseCallback: responseCallback || OK,
  });
}

export function listEntries(businessDate) {
  return get(`/api/v1/queues/entry?businessDate=${businessDate || BUSINESS_DATE}`, TAG.entryList);
}

// action: 'enter' | 'cancel' | 'no-show'. 요청 바디 없음.
// WAITING 이 아닌 대기를 전이시키면 409 STATE_CONFLICT — 의도된 오류로 처리한다.
export function transitionEntry(entryId, action, allowConflict) {
  return post(`/api/v1/queues/entry/${entryId}/${action}`, null, TAG.entryTransition, {
    headers: writeHeaders({}),
    responseCallback: allowConflict ? OK_OR_CONFLICT : OK,
    tags: { action: action },
  });
}

// ---------------------------------------------------------------------------
// 조리 목록
//   주의: 조리 항목은 HTTP 로 생성되지 않는다. OrderAccepted 이벤트를 소비할 때
//   PREPARING 으로 자동 생성된다. 결제 승인 흐름이 없으면 목록이 계속 빌 수 있다.
// ---------------------------------------------------------------------------

export function listFulfillment() {
  return get('/api/v1/queues/fulfillment', TAG.fulfillmentList);
}

export function markReady(fulfillmentId, allowConflict) {
  return post(`/api/v1/queues/fulfillment/${fulfillmentId}/ready`, null, TAG.fulfillmentReady, {
    headers: writeHeaders({}),
    responseCallback: allowConflict ? OK_OR_CONFLICT : OK,
  });
}
