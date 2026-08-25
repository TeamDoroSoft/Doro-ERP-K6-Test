// 시나리오 10. 한계 탐색 (Stress)
//   부하 모델: 닫힌 모델을 계단식으로 올린다.
//
//   목적은 "통과"가 아니라 "어디서 처음 무너지는가"를 찾는 것이다.
//   무너지지 않으면 STRESS_STEPS 를 더 올려서 다시 돌린다.
//
//   각 단계에 step 태그를 붙여 단계별 지표를 따로 본다.
//     http_req_duration{step:300}
//     http_req_failed{step:300}
//
//   k6 run -e BASE_URL=... -e RUN_ID=LOADTEST-007 scenarios/s10_stress.js
//   k6 run -e STRESS_STEPS=200,400,600,800 -e STEP_DURATION=3m ... scenarios/s10_stress.js

import { thresholds } from '../config/thresholds.js';
import { LOAD, SMOKE } from '../config/env.js';
import { loadFixtures } from '../lib/setupData.js';
import { staffMixedIteration } from '../lib/mixed.js';

// 기본 계단: 100 → 200 → 300 → 400 → 500
const STEPS = (__ENV.STRESS_STEPS || `${Math.round(LOAD.normal)},${Math.round(LOAD.normal * 2)},${Math.round(LOAD.peak)},${Math.round(LOAD.peak * 1.33)},${Math.round(LOAD.limit)}`)
  .split(',')
  .map((v) => parseInt(v.trim(), 10))
  .filter((v) => v > 0);

const STEP_DURATION = __ENV.STEP_DURATION || '3m';
const RAMP = __ENV.STEP_RAMP || '30s';

function seconds(dur) {
  const m = /^(\d+)(s|m)$/.exec(dur);
  if (!m) return 180;
  return parseInt(m[1], 10) * (m[2] === 'm' ? 60 : 1);
}

// 단계마다 별도 scenario 를 만들고 startTime 으로 순서를 준다.
// 이렇게 해야 단계별 지표가 태그로 분리된다.
function buildScenarios() {
  if (SMOKE) {
    return {
      step_smoke: {
        executor: 'constant-vus',
        vus: 1,
        duration: '30s',
        exec: 'flow',
        tags: { step: 'smoke' },
      },
    };
  }

  const stepSec = seconds(STEP_DURATION);
  const rampSec = seconds(RAMP);
  const out = {};
  let t = 0;
  for (const vus of STEPS) {
    out[`step_${vus}`] = {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP, target: vus },
        { duration: STEP_DURATION, target: vus },
        { duration: '10s', target: 0 },
      ],
      startTime: `${t}s`,
      gracefulRampDown: '10s',
      exec: 'flow',
      tags: { step: String(vus) },
    };
    t += rampSec + stepSec + 10 + 20; // 단계 사이 20초 간격 (회복 관찰)
  }
  return out;
}

export const options = {
  scenarios: buildScenarios(),
  // 한계를 찾는 것이 목적이므로 실패했다고 중단하지 않는다.
  // 임계값은 "어느 단계에서 넘겼는지"를 표시하는 눈금으로만 쓴다.
  thresholds: thresholds(),
};

export function setup() {
  console.log(`[한계 탐색] 단계: ${STEPS.join(' → ')} VU, 각 ${STEP_DURATION}`);
  return loadFixtures();
}

export function flow(data) {
  staffMixedIteration(data);
}

export function teardown() {
  console.log('');
  console.log('결과를 볼 때 단계별로 끊어서 봅니다:');
  console.log('  http_req_duration{step:100}  ~  {step:500}');
  console.log('  http_req_failed{step:100}    ~  {step:500}');
  console.log('처음으로 p95 가 튀거나 실패율이 오르는 단계가 이 시스템의 한계입니다.');
  console.log('마지막 단계까지 멀쩡하면 STRESS_STEPS 를 더 올려 다시 실행하세요.');
}
