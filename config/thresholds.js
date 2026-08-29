// 합격 기준 (문서 5.2). 운영 목표 확정 전까지는 제안값이다.

const READ_TAGS = ['menu', 'order_list', 'order_detail', 'table_list', 'entry_list', 'fulfillment_list'];
const WRITE_TAGS = [
  'order_create', 'order_complete', 'order_cancel', 'entry_create',
  'entry_transition', 'fulfillment_ready', 'kiosk_activate', 'login',
];

function readThresholds() {
  const t = {};
  for (const tag of READ_TAGS) {
    t[`http_req_duration{name:${tag}}`] = ['p(95)<500'];
  }
  return t;
}

function writeThresholds() {
  const t = {};
  for (const tag of WRITE_TAGS) {
    t[`http_req_duration{name:${tag}}`] = ['p(95)<1000', 'p(99)<2000'];
  }
  return t;
}

export const baseThresholds = {
  // 의도된 오류는 responseCallback 으로 제외되므로 여기 실패율은 진짜 실패만 센다.
  http_req_failed: ['rate<0.01'],
  checks: ['rate>0.99'],
  ...readThresholds(),
  ...writeThresholds(),
};

// 무인 실행(시나리오 9)용 자동 중단. 문서 8.1
export const abortThresholds = {
  http_req_failed: [
    { threshold: 'rate<0.01' },
    { threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '1m' },
  ],
  'http_req_duration{name:order_create}': [
    { threshold: 'p(95)<1000' },
    { threshold: 'p(95)<5000', abortOnFail: true, delayAbortEval: '1m' },
  ],
};

export function withAbort(extra) {
  return Object.assign({}, baseThresholds, abortThresholds, extra || {});
}

export function thresholds(extra) {
  return Object.assign({}, baseThresholds, extra || {});
}
