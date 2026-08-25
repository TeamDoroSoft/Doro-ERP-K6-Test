import http from 'k6/http';
import { fail } from 'k6';
import {
  BASE_URL, TENANT_CODE, OWNER_ID, OWNER_PW,
  STAFF_PREFIX, STAFF_PW, STAFF_COUNT,
  KIOSK_PREFIX, KIOSK_SECRET, KIOSK_COUNT,
} from '../config/env.js';
import { post, TAG, okCheck } from './http.js';
import { reloginCount } from './metrics.js';

// ---------------------------------------------------------------------------
// 인증 방식 요약 (명세 확인 결과)
//   - 직원: POST /api/v1/auth/login → SESSION(HttpOnly) + XSRF-TOKEN 쿠키
//           비-GET 요청은 X-XSRF-TOKEN 헤더에 XSRF-TOKEN 쿠키 값을 그대로 넣어야 한다
//   - 키오스크: POST /api/v1/kiosk-auth/activate → 204, DORO_KIOSK_DEVICE 쿠키
//   - SESSION 과 DORO_KIOSK_DEVICE 가 동시에 있으면 401 AMBIGUOUS_AUTHENTICATION
//     → 한 VU 안에서 직원과 키오스크를 섞으면 안 된다.
// ---------------------------------------------------------------------------

// VU 로컬 상태. setup() 의 쿠키는 VU 로 전달되지 않으므로 VU 당 1회 로그인한다.
// (문서 규칙 2 의 취지 — 매 반복 로그인 금지 — 를 이 방식으로 지킨다)
const state = {
  role: null,      // 'staff' | 'kiosk'
  ready: false,
  csrf: null,
  loginId: null,
  deviceCode: null,
};

function jar() {
  return http.cookieJar();
}

function readCsrf() {
  const cookies = jar().cookiesForURL(BASE_URL);
  const v = cookies['XSRF-TOKEN'];
  return v && v.length ? v[0] : null;
}

// 직원 계정을 VU 번호로 배분한다 (문서 규칙 3).
export function staffLoginId(offset) {
  const n = ((__VU - 1 + (offset || 0)) % STAFF_COUNT) + 1;
  return `${STAFF_PREFIX}${String(n).padStart(3, '0')}`;
}

export function kioskDeviceCode(offset) {
  const n = ((__VU - 1 + (offset || 0)) % KIOSK_COUNT) + 1;
  return `${KIOSK_PREFIX}${String(n).padStart(3, '0')}`;
}

export function loginRaw(loginId, password) {
  return post('/api/v1/auth/login', {
    tenantCode: TENANT_CODE,
    loginId: loginId,
    password: password || STAFF_PW,
  }, TAG.login);
}

// 직원 세션 확보. 이미 있으면 아무것도 하지 않는다.
export function ensureStaff(opts) {
  const o = opts || {};
  if (state.role === 'kiosk') fail('한 VU 에서 직원과 키오스크를 섞을 수 없다 (AMBIGUOUS_AUTHENTICATION)');
  if (state.ready) return state;

  state.loginId = o.owner ? OWNER_ID : staffLoginId(o.offset);
  const res = loginRaw(state.loginId, o.owner ? OWNER_PW : STAFF_PW);
  okCheck(res, '직원 로그인', [200]);
  if (res.status !== 200) {
    fail(`로그인 실패 ${res.status} ${String(res.body).slice(0, 200)}`);
  }
  state.csrf = readCsrf();
  state.role = 'staff';
  state.ready = true;
  return state;
}

// 키오스크 기기 활성화. VU 당 1회.
export function ensureKiosk(opts) {
  const o = opts || {};
  if (state.role === 'staff') fail('한 VU 에서 직원과 키오스크를 섞을 수 없다 (AMBIGUOUS_AUTHENTICATION)');
  if (state.ready) return state;

  state.deviceCode = kioskDeviceCode(o.offset);
  const res = post('/api/v1/kiosk-auth/activate', {
    tenantCode: TENANT_CODE,
    deviceCode: state.deviceCode,
    secret: KIOSK_SECRET,
  }, TAG.kioskActivate);
  okCheck(res, '키오스크 활성화', [204, 200]);
  if (res.status !== 204 && res.status !== 200) {
    fail(`키오스크 활성화 실패 ${res.status} ${String(res.body).slice(0, 200)}`);
  }
  state.role = 'kiosk';
  state.ready = true;
  return state;
}

// 세션이 끊겼을 때 다시 로그인한다. 발생 횟수를 지표로 남긴다 (문서 5.1).
export function relogin() {
  reloginCount.add(1);
  state.ready = false;
  state.csrf = null;
  if (state.role === 'kiosk') {
    state.role = null;
    return ensureKiosk();
  }
  state.role = null;
  return ensureStaff();
}

// 401 이면 한 번만 재로그인하고 true 를 돌려준다.
export function handleAuthLoss(res) {
  if (res.status === 401) {
    relogin();
    return true;
  }
  return false;
}

// 비-GET 요청에 붙일 헤더. CSRF 는 직원 세션에만 의미가 있다.
export function writeHeaders(extra) {
  const h = Object.assign({}, extra || {});
  if (state.role === 'staff') {
    const csrf = state.csrf || readCsrf();
    if (csrf) {
      state.csrf = csrf;
      h['X-XSRF-TOKEN'] = csrf;
    }
  }
  return h;
}

export function currentRole() {
  return state.role;
}
