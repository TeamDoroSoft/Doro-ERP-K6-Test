// 시나리오 4. 입장 대기 등록 및 상태 변경
//   부하 모델: 등록·전이는 열린 모델, 목록 조회는 닫힌 모델. 세 개를 병행한다.
//
//   문서 규칙 3: 상태 변경은 "자신이 등록한 대기"만 건드린다.
//   문서 규칙 4: 이미 종료된 대기의 재전이(409)는 의도된 오류로 따로 센다.
//
//   k6 run -e BASE_URL=... -e RUN_ID=LOADTEST-007 scenarios/s4_entry_queue.js

import { sleep, check } from 'k6';
import { thresholds } from '../config/thresholds.js';
import { RATE, LOAD, SMOKE } from '../config/env.js';
import { json, okCheck, pick, randInt } from '../lib/http.js';
import { ensureStaff, handleAuthLoss } from '../lib/auth.js';
import { createEntry, listEntries, transitionEntry } from '../lib/api.js';
import { expectedErrors } from '../lib/metrics.js';

const DUR = SMOKE ? '30s' : '8m';
const viewers = SMOKE ? 1 : Math.round(LOAD.normal / 5);

export const options = {
  scenarios: {
    // 대기 등록 + 자기 대기 전이 (한 VU 안에서 등록 → 전이까지)
    entry_write: SMOKE
      ? { executor: 'constant-arrival-rate', rate: 1, timeUnit: '1s', duration: DUR, preAllocatedVUs: 3, exec: 'writeFlow' }
      : {
          executor: 'constant-arrival-rate',
          rate: Math.max(1, Math.round(RATE.normal / 3)),
          timeUnit: '1s',
          duration: DUR,
          preAllocatedVUs: 20,
          maxVUs: LOAD.normal,
          exec: 'writeFlow',
        },
    // 직원들이 대기 목록을 계속 새로고침하는 상황
    entry_read: {
      executor: 'constant-vus',
      vus: viewers,
      duration: DUR,
      exec: 'readFlow',
      startTime: '0s',
    },
  },
  thresholds: thresholds(),
};

export function writeFlow() {
  ensureStaff();

  // 1) 대기 등록
  let res = createEntry(randInt(1, 6));
  if (handleAuthLoss(res)) res = createEntry(randInt(1, 6));
  if (!okCheck(res, '대기 등록', [201])) return;

  const entry = json(res);
  check(entry, {
    '대기번호 발급됨': (e) => e && typeof e.queueNumber === 'number' && e.queueNumber >= 1,
    '초기 상태 WAITING': (e) => e && e.status === 'WAITING',
  });
  if (!entry || !entry.entryId) return;

  sleep(randInt(1, 3));

  // 3) 자기가 만든 대기만 전이시킨다
  const action = pick(['enter', 'cancel', 'no-show']);
  const t1 = transitionEntry(entry.entryId, action);
  okCheck(t1, `대기 ${action}`, [200]);

  // 이미 종료된 대기를 다시 전이 → 409 가 정상 (의도된 오류)
  if (Math.random() < 0.2) {
    const t2 = transitionEntry(entry.entryId, action, true);
    if (t2.status === 409) {
      expectedErrors.add(1, { case: 'entry_retransition' });
    }
    check(t2, { '종료된 대기 재전이는 409': (r) => r.status === 409 });
  }
}

export function readFlow() {
  ensureStaff({ offset: 1000 }); // 조회 전용 VU 는 다른 계정을 쓴다
  const res = listEntries();
  okCheck(res, '대기 목록', [200]);
  sleep(randInt(3, 5));
}
