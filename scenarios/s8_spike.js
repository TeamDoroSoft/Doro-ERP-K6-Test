// 시나리오 8. 순간 급증 (Spike)
//   부하 모델: 열린 모델. 요청 비율은 시나리오 7 과 동일.
//   평상시 30% → 30초 만에 150% → 3분 유지 → 1분 만에 30% → 5분 회복 관찰
//
//   보는 것: 급증 구간의 타임아웃·5xx, 주문 유실·중복, 그리고
//            부하가 내려간 뒤 "몇 분 만에" 정상 응답시간으로 돌아오는지.
//
//   k6 run -e BASE_URL=... -e RUN_ID=LOADTEST-007 scenarios/s8_spike.js

import { thresholds } from '../config/thresholds.js';
import { RATE, LOAD, SMOKE } from '../config/env.js';
import { loadFixtures } from '../lib/setupData.js';
import { staffMixedIteration } from '../lib/mixed.js';
import { kioskMixedIteration } from '../lib/kioskMixed.js';

const FULL = RATE.limit;
const pct = (p) => Math.max(1, Math.round(FULL * p));

const stages = [
  { duration: '3m', target: pct(0.3) },   // 평상시
  { duration: '30s', target: pct(1.5) },  // 급증
  { duration: '3m', target: pct(1.5) },   // 최대 유지
  { duration: '1m', target: pct(0.3) },   // 감소
  { duration: '5m', target: pct(0.3) },   // 회복 관찰
];

const smokeStages = [{ duration: '20s', target: 2 }, { duration: '20s', target: 4 }];

// 급증 구간은 느려지는 것이 정상이므로 응답시간 임계값을 완화한다.
// 대신 5xx 와 데이터 정합성은 그대로 본다.
const spikeThresholds = thresholds({
  'http_req_duration{name:order_create}': ['p(95)<3000'],
  'http_req_failed': ['rate<0.05'],
});

export const options = {
  scenarios: {
    staff: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: SMOKE ? 3 : Math.max(30, Math.round(LOAD.limit * 0.6)),
      maxVUs: SMOKE ? 5 : Math.round(LOAD.limit * 1.2),
      stages: SMOKE ? smokeStages : stages.map((s) => ({ duration: s.duration, target: Math.max(1, Math.round(s.target * 0.8)) })),
      exec: 'staffFlow',
    },
    kiosk: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: SMOKE ? 2 : Math.max(10, Math.round(LOAD.limit * 0.15)),
      maxVUs: SMOKE ? 3 : Math.round(LOAD.limit * 0.3),
      stages: SMOKE ? smokeStages : stages.map((s) => ({ duration: s.duration, target: Math.max(1, Math.round(s.target * 0.2)) })),
      exec: 'kioskFlow',
    },
  },
  thresholds: spikeThresholds,
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
