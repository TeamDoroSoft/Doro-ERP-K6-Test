// ---------------------------------------------------------------------------
// 키오스크 기기 등록 시드
//   부하 workload 의 40% 가 키오스크이므로 기기를 미리 등록해 둬야 한다.
//
//   POST /api/v1/kiosk-devices  { deviceCode }
//     → 200 { kioskDeviceId, credential: "kdc_<id>.<secret>" }
//   credential 은 등록 응답에만 나온다(1회성). 반드시 여기서 받아 저장한다.
//
//   제약
//     - OWNER/MANAGER 세션 + 최근 재인증(15분 이내) 필요
//     - 멱등성 없음. 같은 deviceCode 재등록은 409
//       이미 있는 기기는 ROTATE=1 로 credential 을 새로 발급받는다
//
//   실행
//     k6 run -e BASE_URL=https://origin.doro.minseok.click \
//            -e TENANT_CODE=e2e-auth-active \
//            -e OWNER_ID=e2e-role-owner -e OWNER_PW="$OWNER_PW" \
//            -e SEED_KIOSK=40 seed/seed_kiosk.js
//
//     이미 등록된 기기의 credential 을 새로 받으려면  -e ROTATE=1
// ---------------------------------------------------------------------------

import { fail, check } from 'k6';
import { post, get, json, idemKey } from '../lib/http.js';
import { ensureStaff, writeHeaders } from '../lib/auth.js';
import { OWNER_PW, TENANT_CODE, KIOSK_PREFIX } from '../config/env.js';

const COUNT = Number(__ENV.SEED_KIOSK || 40);
const ROTATE = String(__ENV.ROTATE || '') === '1';
// 재인증은 15분 유효. 넉넉하게 이 개수마다 갱신한다.
const REAUTH_EVERY = Number(__ENV.REAUTH_EVERY || 50);

export const options = {
  scenarios: { seed: { executor: 'per-vu-iterations', vus: 1, iterations: 1, maxDuration: '30m' } },
  thresholds: {},
};

function reauthenticate() {
  const res = post('/api/v1/auth/reauthenticate', { password: OWNER_PW }, 'reauthenticate', {
    headers: writeHeaders({}),
  });
  if (res.status !== 204 && res.status !== 200) {
    fail(`재인증 실패 ${res.status} ${String(res.body).slice(0, 200)}`);
  }
}

function deviceCode(i) {
  return `${KIOSK_PREFIX}${String(i).padStart(3, '0')}`;
}

export default function () {
  console.log(`[키오스크 시드] 업체=${TENANT_CODE} 목표 ${COUNT}대 (rotate=${ROTATE})`);

  ensureStaff({ owner: true });
  reauthenticate();

  // 이미 등록된 기기 목록 (재인증 불필요)
  const listRes = get('/api/v1/kiosk-devices', 'kiosk_device_list');
  if (listRes.status !== 200) fail(`기기 목록 조회 실패 ${listRes.status}`);
  const existing = {};
  const list = json(listRes) || [];
  for (const d of list) existing[d.deviceCode] = d;
  console.log(`[키오스크 시드] 기존 등록 ${list.length}대`);

  const secrets = [];   // device 순서대로. 없으면 빈 문자열
  let registered = 0;
  let rotated = 0;
  let skipped = 0;

  for (let i = 1; i <= COUNT; i++) {
    if (i % REAUTH_EVERY === 0) reauthenticate();

    const code = deviceCode(i);
    const known = existing[code];

    if (known && !ROTATE) {
      // credential 을 다시 받을 수 없다. ROTATE=1 로 재발급해야 한다.
      secrets.push('');
      skipped++;
      continue;
    }

    let res;
    if (known && ROTATE) {
      res = post(`/api/v1/kiosk-devices/${known.id}/rotate`, null, 'kiosk_device_rotate', {
        headers: writeHeaders({}),
      });
      if (res.status === 200) rotated++;
    } else {
      res = post('/api/v1/kiosk-devices', { deviceCode: code }, 'kiosk_device_register', {
        headers: writeHeaders({ 'Idempotency-Key': idemKey('kiosk-device') }),
      });
      if (res.status === 200 || res.status === 201) registered++;
    }

    if (res.status !== 200 && res.status !== 201) {
      console.error(`${code} 실패 ${res.status} ${String(res.body).slice(0, 200)}`);
      secrets.push('');
      continue;
    }

    const c = json(res);
    secrets.push((c && c.credential) ? c.credential : '');
  }

  const usable = secrets.filter(Boolean).length;

  console.log('');
  console.log('================ 키오스크 시드 결과 ================');
  console.log(`신규 등록   : ${registered}대`);
  console.log(`credential 재발급 : ${rotated}대`);
  console.log(`건너뜀(기존, credential 없음) : ${skipped}대`);
  console.log(`사용 가능   : ${usable}/${COUNT}대`);
  console.log('===================================================');
  console.log('');
  console.log('아래 한 줄을 그대로 환경변수로 내보내세요 (기기 순서대로 정렬되어 있습니다):');
  console.log('');
  console.log(`export KIOSK_SECRETS='${secrets.join(',')}'`);
  console.log('');
  if (skipped > 0) {
    console.log(`⚠ ${skipped}대는 이미 등록되어 있어 credential 을 받지 못했습니다.`);
    console.log('  ROTATE=1 로 다시 실행하면 재발급됩니다: -e ROTATE=1');
  }
  console.log('⚠ credential 은 비밀값입니다. 결과 파일이나 저장소에 커밋하지 마세요.');

  check(null, { '사용 가능한 키오스크 기기 확보': () => usable > 0 });
}
