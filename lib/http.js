import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, RUN_ID } from '../config/env.js';
import { expectedErrors } from './metrics.js';

// ---------------------------------------------------------------------------
// 태그 (문서 규칙 1)
//   URL 에 id 가 들어가는 요청은 반드시 고정 name 태그를 붙인다.
//   태그를 빼면 주문 1건마다 별개 지표가 생겨 p95 를 낼 수 없다.
// ---------------------------------------------------------------------------
export const TAG = {
  login: 'login',
  menu: 'menu',
  orderList: 'order_list',
  orderCreate: 'order_create',
  orderDetail: 'order_detail',
  orderComplete: 'order_complete',
  orderCancel: 'order_cancel',
  tableList: 'table_list',
  kioskActivate: 'kiosk_activate',
  entryCreate: 'entry_create',
  entryList: 'entry_list',
  entryTransition: 'entry_transition',
  fulfillmentList: 'fulfillment_list',
  fulfillmentReady: 'fulfillment_ready',
};

export function url(path) {
  return `${BASE_URL}${path}`;
}

// ---------------------------------------------------------------------------
// 멱등키 (문서 규칙 5)
//   {RUN_ID}-{VU}-{ITER}-{용도} 형식. Redis 정리 시 RUN_ID 접두사로 골라 지운다.
// ---------------------------------------------------------------------------
//   VU·반복 번호는 회차를 다시 돌리면 그대로 반복된다. 이전 회차의 키가 서버에
//   남아 있으면 첫 요청이 409(또는 재생)로 처리되어 검증이 무의미해지므로,
//   VU 초기화 시점의 난수를 한 조각 섞는다. 접두사는 RUN_ID 그대로 두어
//   Redis 정리(문서 3.3.3)에서 골라 지울 수 있게 한다.
const NONCE = Math.random().toString(36).slice(2, 10);
let seq = 0;
export function idemKey(purpose) {
  seq += 1;
  return `${RUN_ID}-${NONCE}-${__VU}-${__ITER}-${purpose}-${seq}`;
}

// ---------------------------------------------------------------------------
// 의도된 오류 (문서 규칙 4)
//   거절되는 것이 정상인 요청은 기본 실패 판정에서 빼고 별도 카운터로 센다.
//   responseCallback 에 허용 코드를 넘기면 http_req_failed 에 잡히지 않는다.
// ---------------------------------------------------------------------------
export const OK = http.expectedStatuses(200, 201, 204);
export const OK_OR_CONFLICT = http.expectedStatuses(200, 201, 204, 409);
export const OK_OR_BAD_REQUEST = http.expectedStatuses(200, 201, 204, 400);
// 매장 주문에서 테이블이 아직 해제되지 않은 경우 503 이 온다 (서버 장애 아님)
export const OK_OR_UNAVAILABLE = http.expectedStatuses(200, 201, 204, 503);

function opts(tag, extra) {
  const o = Object.assign({ responseCallback: OK }, extra || {});
  o.tags = Object.assign({ name: tag }, o.tags || {});
  return o;
}

export function get(path, tag, extra) {
  return http.get(url(path), opts(tag, extra));
}

export function post(path, body, tag, extra) {
  const o = opts(tag, extra);
  if (body === null || body === undefined) {
    // 바디 없는 POST (complete / cancel / ready / entry 전이).
    // Content-Type 을 붙이지 않는다.
    return http.post(url(path), null, o);
  }
  o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
  return http.post(url(path), JSON.stringify(body), o);
}

// 의도된 오류를 기록한다. 기대한 상태 코드가 나왔으면 expected_errors 를 올린다.
export function recordExpected(res, wantedStatus, label) {
  const hit = res.status === wantedStatus;
  if (hit) expectedErrors.add(1, { case: label });
  return hit;
}

export function json(res) {
  try {
    return res.json();
  } catch (e) {
    return null;
  }
}

export function okCheck(res, label, wanted) {
  const want = wanted || [200, 201, 204];
  return check(res, {
    [`${label} 성공`]: (r) => want.indexOf(r.status) !== -1,
  });
}

export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function pickN(arr, n) {
  const copy = arr.slice();
  const out = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}

export function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}
