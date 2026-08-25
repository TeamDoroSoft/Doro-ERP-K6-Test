// 시나리오 9. 장시간 안정성 (Soak)
//   부하 모델: 열린 모델. 기준 부하의 40% 로 1시간.
//   1차에서 응답시간이 우상향하면 SOAK_DURATION=4h 로 재실행한다.
//
//   무인 실행이므로 자동 중단(abortOnFail)을 켠다. 문서 8.1
//   보는 것: 시간에 따른 p95 기울기, 메모리·연결 누수, 재로그인 횟수,
//            실행 중 영업일이 바뀌는 경우의 동작.
//
//   k6 run -e BASE_URL=... -e RUN_ID=LOADTEST-007 -e SOAK_DURATION=1h scenarios/s9_soak.js

import { withAbort } from '../config/thresholds.js';
import { RATE, LOAD, SMOKE } from '../config/env.js';
import { loadFixtures } from '../lib/setupData.js';
import { staffMixedIteration } from '../lib/mixed.js';
import { kioskMixedIteration } from '../lib/kioskMixed.js';

const DURATION = __ENV.SOAK_DURATION || '1h';
const FULL = RATE.limit;
const target = Math.max(1, Math.round(FULL * 0.4));

export const options = {
  scenarios: {
    staff: SMOKE
      ? { executor: 'constant-arrival-rate', rate: 1, timeUnit: '1s', duration: '30s', preAllocatedVUs: 3, exec: 'staffFlow' }
      : {
          executor: 'constant-arrival-rate',
          rate: Math.max(1, Math.round(target * 0.8)),
          timeUnit: '1s',
          duration: DURATION,
          preAllocatedVUs: Math.max(20, Math.round(LOAD.normal * 0.5)),
          maxVUs: Math.round(LOAD.peak),
          exec: 'staffFlow',
        },
    kiosk: SMOKE
      ? { executor: 'constant-arrival-rate', rate: 1, timeUnit: '1s', duration: '30s', preAllocatedVUs: 2, exec: 'kioskFlow' }
      : {
          executor: 'constant-arrival-rate',
          rate: Math.max(1, Math.round(target * 0.2)),
          timeUnit: '1s',
          duration: DURATION,
          preAllocatedVUs: Math.max(10, Math.round(LOAD.normal * 0.2)),
          maxVUs: Math.round(LOAD.normal),
          exec: 'kioskFlow',
        },
  },
  thresholds: withAbort(),
};

export function setup() {
  return loadFixtures();
}

export function staffFlow(data) {
  staffMixedIteration(data);
}

export function kioskFlow(data) {
  kioskMixedIteration(data);
}
