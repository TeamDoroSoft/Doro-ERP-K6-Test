// 초기 데이터 생성 (문서 3.3.4)
//   k6 를 스크립트 러너로 쓴다. 1 VU / 1 iteration 으로 한 번만 돈다.
//
//   k6 run -e BASE_URL=... -e RUN_ID=LOADTEST-007 -e TENANT_CODE=loadtest007 \
//          -e OWNER_ID=owner01 -e OWNER_PW='...' \
//          -e SEED_STAFF=500 -e SEED_TABLES=500 -e SEED_PRODUCTS=24 \
//          seed/seed.js
//
// ⚠ 선행 작업 (수동)
//   업체 생성(POST /api/v1/provider/tenants)과 최초 OWNER 생성
//   (POST /api/v1/provider/tenants/{tenantId}/first-owner)은 Provider Admin 경로다.
//   admin 프로파일로 뜬 Edge 에서만 노출되고 OIDC 로그인이 필요해 k6 로 자동화하기
//   어렵다. 업체와 OWNER 계정은 미리 만들어 두고, 이 스크립트는 그 아래를 채운다.
//
// ⚠ 이 스크립트는 k6 부하 시나리오의 setup() 과 분리해서 별도로 실행한다.
//   setup() 안에서 만들면 실행할 때마다 데이터가 중복 생성된다 (문서 3.3.4).

import { fail } from 'k6';
import { check } from 'k6';
import { post, get, json, okCheck } from '../lib/http.js';
import { writeHeaders } from '../lib/auth.js';
import { loginRaw } from '../lib/auth.js';
import { OWNER_ID, OWNER_PW, STAFF_PREFIX, STAFF_PW, RUN_ID, TENANT_CODE } from '../config/env.js';

const SEED_STAFF = Number(__ENV.SEED_STAFF || 100);
const SEED_TABLES = Number(__ENV.SEED_TABLES || 100);
const SEED_CATEGORIES = Number(__ENV.SEED_CATEGORIES || 4);
const SEED_PRODUCTS = Number(__ENV.SEED_PRODUCTS || 24);

export const options = {
  scenarios: {
    seed: { executor: 'per-vu-iterations', vus: 1, iterations: 1, maxDuration: '30m' },
  },
  // 시드는 성능 측정 대상이 아니므로 임계값을 두지 않는다.
  thresholds: {},
};

export default function () {
  console.log(`[시드] 업체=${TENANT_CODE} RUN_ID=${RUN_ID}`);

  // 1) OWNER 로그인
  const login = loginRaw(OWNER_ID, OWNER_PW);
  if (login.status !== 200) {
    fail(`OWNER 로그인 실패 ${login.status}. 업체와 최초 OWNER 계정이 만들어져 있는지 확인하세요.\n` +
         `본문: ${String(login.body).slice(0, 300)}`);
  }
  const me = json(login);
  if (me && me.passwordChangeRequired) {
    console.warn('[경고] OWNER 비밀번호 변경이 필요한 상태입니다. ' +
      'PATCH /api/v1/employees/me/password 로 먼저 변경한 뒤 다시 실행하세요.');
  }

  // 2) 카테고리
  const categoryIds = [];
  for (let i = 1; i <= SEED_CATEGORIES; i++) {
    const res = post('/api/v1/catalog/categories', {
      name: `부하테스트 카테고리 ${i}`,
      displayOrder: i - 1,
      active: true,
    }, 'seed_category', { headers: writeHeaders({}) });
    if (res.status === 201 || res.status === 200) {
      const c = json(res);
      if (c && c.categoryId) categoryIds.push(c.categoryId);
    } else {
      console.error(`카테고리 ${i} 생성 실패 ${res.status} ${String(res.body).slice(0, 200)}`);
    }
  }
  check(null, { '카테고리 생성됨': () => categoryIds.length > 0 });
  if (categoryIds.length === 0) fail('카테고리를 하나도 만들지 못했습니다.');
  console.log(`[시드] 카테고리 ${categoryIds.length}개`);

  // 3) 상품 — 카테고리에 고르게 분배
  let productCount = 0;
  for (let i = 1; i <= SEED_PRODUCTS; i++) {
    const res = post('/api/v1/catalog/products', {
      categoryId: categoryIds[(i - 1) % categoryIds.length],
      name: `부하테스트 상품 ${String(i).padStart(3, '0')}`,
      description: `${RUN_ID} 부하 테스트용`,
      price: 1000 * (1 + (i % 12)),
      displayOrder: i - 1,
      active: true,
    }, 'seed_product', { headers: writeHeaders({}) });
    if (res.status === 201 || res.status === 200) productCount++;
    else console.error(`상품 ${i} 생성 실패 ${res.status} ${String(res.body).slice(0, 200)}`);
  }
  console.log(`[시드] 상품 ${productCount}개`);

  // 4) 테이블 — 최대 VU 수 이상 (문서 규칙 3)
  let tableCount = 0;
  for (let i = 1; i <= SEED_TABLES; i++) {
    const n = String(i).padStart(4, '0');
    const res = post('/api/v1/tables', {
      tableNumber: `T${n}`,
      displayName: `부하 ${n}번`,
    }, 'seed_table', { headers: writeHeaders({}) });
    if (res.status === 201 || res.status === 200) tableCount++;
    else if (i <= 3) console.error(`테이블 ${i} 생성 실패 ${res.status} ${String(res.body).slice(0, 200)}`);
  }
  console.log(`[시드] 테이블 ${tableCount}개`);

  // 5) 직원 계정 — 최대 VU 수 이상 (문서 규칙 2, 세션 배분용)
  let staffCount = 0;
  for (let i = 1; i <= SEED_STAFF; i++) {
    const loginId = `${STAFF_PREFIX}${String(i).padStart(3, '0')}`;
    const res = post('/api/v1/employees', {
      loginId: loginId,
      temporaryPassword: STAFF_PW,
      role: 'STAFF',
    }, 'seed_employee', { headers: writeHeaders({}) });
    if (res.status === 201 || res.status === 200) staffCount++;
    else if (i <= 3) console.error(`직원 ${loginId} 생성 실패 ${res.status} ${String(res.body).slice(0, 200)}`);
  }
  console.log(`[시드] 직원 ${staffCount}개`);

  // 6) 확인
  const menu = get('/api/v1/catalog/menu', 'seed_verify_menu');
  const tables = get('/api/v1/tables', 'seed_verify_tables');
  okCheck(menu, '메뉴 확인', [200]);
  okCheck(tables, '테이블 확인', [200]);

  const m = json(menu);
  const productsVisible = m && m.categories
    ? m.categories.reduce((acc, c) => acc + ((c.products || []).length), 0)
    : 0;
  const tablesVisible = Array.isArray(json(tables)) ? json(tables).length : 0;

  console.log('');
  console.log('================ 시드 결과 ================');
  console.log(`업체 코드     : ${TENANT_CODE}`);
  console.log(`판매 상품     : ${productsVisible}개`);
  console.log(`활성 테이블   : ${tablesVisible}개`);
  console.log(`직원 계정     : ${staffCount}개 (${STAFF_PREFIX}001 ~)`);
  console.log('==========================================');
  console.log('');
  console.log('⚠ 직원 계정이 임시 비밀번호 상태(passwordChangeRequired=true)면');
  console.log('  로그인은 되지만 일부 API 가 막힐 수 있습니다. 첫 로그인 결과를 확인하세요.');
  console.log('⚠ 키오스크 기기 등록은 이 스크립트에 포함되어 있지 않습니다.');
  console.log('  기기 등록 API 를 확인해 device001~ 로 미리 등록해 두세요.');

  check(null, {
    '상품이 조회됨': () => productsVisible > 0,
    '테이블이 조회됨': () => tablesVisible > 0,
  });
}
