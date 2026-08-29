// ---------------------------------------------------------------------------
// Prod Alpha 단일 실행 부하테스트
//   문서: prodalphaloadtestscenario.md
//
//   실행 위치 : Prod VPC 내부 Load Generator EC2 (private app_c, t4g.small, AL2023 ARM64)
//   대상      : Internal Alpha ALB HTTPS 443 / Host: origin.doro.minseok.click
//   제외      : Toss Payment confirm / cancel, 실제 PG 승인·취소·환불
//
//   실행 예
//     k6 run -e BASE_URL=https://origin.doro.minseok.click \
//            -e RUN_ID=PRODALPHA-001 -e TENANT_CODE=e2e-auth-active \
//            scenarios/s12_prod_alpha.js
//
//     스모크:  -e SMOKE=1
//     후불결제 빼기: -e POSTPAY=0
// ---------------------------------------------------------------------------

import { fail } from 'k6';
import { loginRaw, staffLoginId } from '../lib/auth.js';
import { get, json } from '../lib/http.js';
import { STAFF_PW, RUN_ID } from '../config/env.js';
import { staffIteration, kioskIteration, warnIfTablesShort, T } from '../lib/prodAlpha.js';

const SMOKE = String(__ENV.SMOKE || '') === '1';

// 문서 7장 부하 단계
const STAGES = [
  { duration: '5m',  total: 10  },   // Stage 1
  { duration: '10m', total: 30  },   // Stage 2
  { duration: '10m', total: 50  },   // Stage 3
  { duration: '15m', total: 100 },   // Stage 4
];
const SMOKE_STAGES = [{ duration: '30s', total: 5 }];

// 직원 60% / 키오스크 40% (인증 방식이 달라 executor 를 나눈다)
const STAFF_SHARE = 0.6;
const KIOSK_SHARE = 0.4;

function vuStages(share) {
  const src = SMOKE ? SMOKE_STAGES : STAGES;
  return src.map((s) => ({
    duration: s.duration,
    target: Math.max(1, Math.round(s.total * share)),
  }));
}

// ---------------------------------------------------------------------------
// 합격 기준 (문서 9장) — 임계값은 서비스 오너가 확정한다. 여기 값은 제안치.
// ---------------------------------------------------------------------------
const READ_TAGS = [T.menuList, T.productDetail, T.tableList, T.orderList, T.orderDetail, T.orderStatus, T.queueStatus];
const WRITE_TAGS = [T.posTakeout, T.kioskTakeout, T.posDineIn, T.kioskDineIn, T.queueRegister, T.queueTransition, T.tablePostpay, 'login', 'kiosk_activate'];

function buildThresholds() {
  const t = {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  };
  for (const tag of READ_TAGS) t[`http_req_duration{name:${tag}}`] = ['p(95)<500', 'p(99)<1000'];
  for (const tag of WRITE_TAGS) t[`http_req_duration{name:${tag}}`] = ['p(95)<1000', 'p(99)<2000'];
  return t;
}

export const options = {
  scenarios: {
    staff: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: vuStages(STAFF_SHARE),
      gracefulRampDown: '30s',
      exec: 'staffFlow',
      tags: { actor: 'staff' },
    },
    kiosk: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: vuStages(KIOSK_SHARE),
      gracefulRampDown: '30s',
      exec: 'kioskFlow',
      tags: { actor: 'kiosk' },
    },
  },
  thresholds: buildThresholds(),
  // 요청마다 새 UUID 형식 X-Request-Id 를 쓰므로 연결 재사용은 유지한다.
  noConnectionReuse: false,
  discardResponseBodies: false,
};

// ---------------------------------------------------------------------------
// setup — 상품과 테이블만 확보한다. 쿠키는 VU 로 전달되지 않으므로
//         세션은 각 VU 가 ensureStaff()/ensureKiosk() 로 1회 확보한다.
// ---------------------------------------------------------------------------
export function setup() {
  const login = loginRaw(staffLoginId(0), STAFF_PW);
  if (login.status !== 200) {
    fail(`setup 로그인 실패 ${login.status}. 시드(seed/seed.js)를 먼저 실행했는지 확인하세요.`);
  }

  const menu = get('/api/v1/catalog/menu', T.menuList);
  if (menu.status !== 200) fail(`메뉴 조회 실패 ${menu.status}`);
  const body = json(menu);
  const productIds = [];
  if (body && body.categories) {
    for (const c of body.categories) for (const p of (c.products || [])) productIds.push(p.productId);
  }
  if (productIds.length === 0) fail('판매 가능한 상품이 없습니다. 시드를 확인하세요.');

  const tables = get('/api/v1/tables', T.tableList);
  if (tables.status !== 200) fail(`테이블 조회 실패 ${tables.status}`);
  const list = json(tables);
  const tableIds = Array.isArray(list) ? list.map((t) => t.id) : [];
  if (tableIds.length === 0) fail('활성 테이블이 없습니다. DINE_IN 흐름을 돌릴 수 없습니다.');

  warnIfTablesShort(tableIds);
  console.log(`[${RUN_ID}] 상품 ${productIds.length}개 / 활성 테이블 ${tableIds.length}개`);

  return { productIds: productIds, tableIds: tableIds };
}

export function staffFlow(data) { staffIteration(data); }
export function kioskFlow(data) { kioskIteration(data); }
