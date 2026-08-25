// 시나리오 7. 실제 영업 혼합 부하
//   부하 모델: 열린 모델 (ramping-arrival-rate)
//   총 27분. 기준 부하(100%)는 config/env.js 의 RATE.limit 을 쓴다.
//
//   직원 80% / 키오스크 20% 로 나눠 두 개의 executor 를 병행한다.
//
//   k6 run -e BASE_URL=... -e RUN_ID=LOADTEST-007 scenarios/s7_mixed.js

import { thresholds } from '../config/thresholds.js';
import { RATE, LOAD, SMOKE } from '../config/env.js';
import { loadFixtures } from '../lib/setupData.js';
import { staffMixedIteration } from '../lib/mixed.js';
import { kioskMixedIteration } from '../lib/kioskMixed.js';

const FULL = RATE.limit; // 100%
const pct = (p) => Math.max(1, Math.round(FULL * p));

// 문서 시나리오 7 의 부하 단계
const stages = [
  { duration: '3m', target: pct(0.3) },  // 준비  0% → 30%
  { duration: '7m', target: pct(0.3) },  // 정상 영업 30%
  { duration: '3m', target: pct(1.0) },  // 피크 진입 30% → 100%
  { duration: '10m', target: pct(1.0) }, // 피크 유지 100%
  { duration: '2m', target: pct(0.2) },  // 회복 확인 100% → 20%
  { duration: '2m', target: 0 },         // 종료
];

const smokeStages = [{ duration: '30s', target: 2 }];

export const options = {
  scenarios: {
    staff: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: SMOKE ? 3 : Math.max(20, Math.round(LOAD.limit * 0.4)),
      maxVUs: SMOKE ? 5 : Math.round(LOAD.limit * 0.8),
      stages: SMOKE ? smokeStages : stages.map((s) => ({ duration: s.duration, target: Math.max(1, Math.round(s.target * 0.8)) })),
      exec: 'staffFlow',
    },
    kiosk: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: SMOKE ? 2 : Math.max(10, Math.round(LOAD.limit * 0.1)),
      maxVUs: SMOKE ? 3 : Math.round(LOAD.limit * 0.2),
      stages: SMOKE ? smokeStages : stages.map((s) => ({ duration: s.duration, target: Math.max(1, Math.round(s.target * 0.2)) })),
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
