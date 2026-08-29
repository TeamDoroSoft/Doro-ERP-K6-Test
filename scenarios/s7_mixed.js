// 시나리오 7. 실제 영업 혼합 부하
//   부하 모델: 닫힌 모델 (ramping-vus)
//   권장 단계: 총 VU 10 → 30 → 50 → 100.
//
//   직원 80% / 키오스크 20% 로 나눠 두 개의 executor 를 병행한다.
//
//   k6 run -e BASE_URL=... -e RUN_ID=LOADTEST-007 scenarios/s7_mixed.js

import { thresholds } from '../config/thresholds.js';
import { SMOKE } from '../config/env.js';
import { loadFixtures } from '../lib/setupData.js';
import { staffMixedIteration } from '../lib/mixed.js';
import { kioskMixedIteration } from '../lib/kioskMixed.js';

const stages = [
  { duration: '5m', total: 10 },
  { duration: '10m', total: 30 },
  { duration: '10m', total: 50 },
  { duration: '15m', total: 100 },
];
const vuStages = (share) => stages.map((s) => ({ duration: s.duration, target: Math.max(1, Math.round(s.total * share)) }));

const smokeStages = [{ duration: '30s', target: 2 }];

export const options = {
  scenarios: {
    staff: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: SMOKE ? smokeStages : vuStages(0.8),
      gracefulRampDown: '30s',
      exec: 'staffFlow',
    },
    kiosk: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: SMOKE ? smokeStages : vuStages(0.2),
      gracefulRampDown: '30s',
      exec: 'kioskFlow',
    },
  },
  thresholds: thresholds(),
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
