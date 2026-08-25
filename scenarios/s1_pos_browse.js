// 시나리오 1. POS 로그인 및 기본 화면 조회
//   부하 모델: 닫힌 모델 (ramping-vus)
//   이 시나리오만 예외적으로 매 반복 로그인한다 (로그인 자체가 측정 대상).
//
//   k6 run -e BASE_URL=... -e RUN_ID=LOADTEST-007 scenarios/s1_pos_browse.js

import { sleep, group } from 'k6';
import { thresholds } from '../config/thresholds.js';
import { LOAD, SMOKE } from '../config/env.js';
import { okCheck, randInt } from '../lib/http.js';
import { loginRaw, staffLoginId } from '../lib/auth.js';
import { STAFF_PW } from '../config/env.js';
import { getMenu, listOrders, listTables, listFulfillment } from '../lib/api.js';

export const options = {
  scenarios: {
    pos_browse: SMOKE
      ? { executor: 'constant-vus', vus: 1, duration: '30s' }
      : {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: [
            { duration: '30s', target: Math.round(LOAD.normal / 3) },
            { duration: '3m', target: Math.round(LOAD.normal / 3) },
            { duration: '30s', target: LOAD.normal },
            { duration: '3m', target: LOAD.normal },
            { duration: '30s', target: 0 },
          ],
          gracefulRampDown: '30s',
        },
  },
  thresholds: thresholds(),
};

export default function () {
  // 1) 로그인
  const login = loginRaw(staffLoginId(0), STAFF_PW);
  okCheck(login, '로그인', [200]);
  if (login.status !== 200) {
    sleep(1);
    return;
  }

  // 2~5) 주문 화면 진입 시 조회되는 것들
  group('첫 화면', function () {
    okCheck(getMenu(), '메뉴');
    okCheck(listOrders(), '오늘 주문');
    okCheck(listTables(), '활성 테이블');
    okCheck(listFulfillment(), '조리 목록');
  });

  sleep(randInt(3, 8));

  // 6) 새로고침
  group('재조회', function () {
    okCheck(listOrders(), '오늘 주문 재조회');
    okCheck(listFulfillment(), '조리 목록 재조회');
  });

  sleep(randInt(3, 8));
}
