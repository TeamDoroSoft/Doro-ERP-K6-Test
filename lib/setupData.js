import { fail } from 'k6';

import { loginRaw, staffLoginId } from './auth.js';
import { getMenu, productIdsFrom, listTables, tableIdsFrom } from './api.js';
import { STAFF_PW, RUN_ID, BUSINESS_DATE, DINE_IN_RATIO, TABLE_RELEASE_SECONDS, log } from '../config/env.js';

// setup() 에서 1회만 실행한다. 반환값은 모든 VU 에 복사되어 전달된다.
// 주의: setup() 의 쿠키는 VU 로 전달되지 않는다. 여기서는 데이터만 가져오고,
//       세션은 각 VU 가 lib/auth.js 의 ensureStaff() 로 1회 확보한다.
export function loadFixtures(forceTables = false) {
  const login = loginRaw(staffLoginId(0), STAFF_PW);
  if (login.status !== 200) {
    fail(`setup 로그인 실패 ${login.status}. 시드 데이터(seed/seed.js)를 먼저 실행했는지 확인하세요.`);
  }

  const menu = getMenu();
  if (menu.status !== 200) fail(`메뉴 조회 실패 ${menu.status}`);
  const productIds = productIdsFrom(menu);
  if (productIds.length === 0) fail('판매 상품이 없습니다. 시드 데이터를 확인하세요.');

  // 매장 주문을 끄면(DINE_IN_RATIO=0) 테이블이 없어도 된다.
  let tableIds = [];
  if (DINE_IN_RATIO > 0 || forceTables) {
    const tables = listTables();
    if (tables.status !== 200) fail(`테이블 조회 실패 ${tables.status}`);
    tableIds = tableIdsFrom(tables);
    if (tableIds.length === 0) fail('활성 테이블이 없습니다. 시드 데이터를 확인하세요.');
  }

  log(`fixtures: 상품 ${productIds.length}개, 테이블 ${tableIds.length}개`);

  return {
    runId: RUN_ID,
    businessDate: BUSINESS_DATE,
    productIds: productIds,
    tableIds: tableIds,
  };
}

// VU 번호로 테이블을 나눠 쓴다 (문서 규칙 3).
// 테이블 수가 VU 수보다 적으면 겹치므로, 시드에서 테이블을 최대 VU 이상 만든다.
export function tableForVU(data) {
  if (!data.tableIds || data.tableIds.length === 0) return null;
  // VU 번호와 반복 번호를 섞어 테이블 풀 전체를 고르게 돌려 쓴다.
  // 같은 테이블을 연속으로 쓰면 이전 주문이 아직 해제되지 않아 503 이 난다.
  const idx = (((__VU - 1) * 31) + (__ITER * 17)) % data.tableIds.length;
  return data.tableIds[idx];
}

// 매장 주문을 켰을 때 테이블이 충분한지 확인한다.
// 필요한 수 = 초당 매장 주문 수 x 해제까지 걸리는 시간 x 1.5(여유)
export function assertEnoughTables(data, dineInPerSecond) {
  if (DINE_IN_RATIO <= 0) return;
  const need = Math.ceil(dineInPerSecond * TABLE_RELEASE_SECONDS * 1.5);
  const have = data.tableIds ? data.tableIds.length : 0;
  if (have < need) {
    console.warn(
      `[경고] 활성 테이블 ${have}개 < 필요 ${need}개 ` +
      `(초당 매장주문 ${dineInPerSecond} x 해제 ${TABLE_RELEASE_SECONDS}초 x 1.5). ` +
      '테이블이 모자라면 503 이 대량 발생합니다.'
    );
  }
}
