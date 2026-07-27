/* 하루 두 번(아침·저녁) 코치 앱에 실제 웹 푸시를 보낸다.
 * 어느 슬롯인지는 어느 cron이 이 워크플로를 깨웠는지(GH_SCHEDULE)로 판단하고,
 * workflow_dispatch로 수동 실행할 때는 FORCED_SLOT으로 강제 지정할 수 있다.
 * '오늘 이미 세션을 했는지'는 서버가 알 수 없으므로 판단하지 않는다 —
 * 그 판단은 코치 앱의 서비스워커(push 이벤트 핸들러)가 폰에 저장된 기록으로 대신한다. */
const webpush = require("web-push");

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const RAW_SUBSCRIPTIONS = process.env.PUSH_SUBSCRIPTIONS;
const GH_SCHEDULE = process.env.GH_SCHEDULE || "";
const FORCED_SLOT = process.env.FORCED_SLOT || "";

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !RAW_SUBSCRIPTIONS) {
  console.error("필요한 시크릿(VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / PUSH_SUBSCRIPTIONS)이 비어 있습니다.");
  process.exit(1);
}

webpush.setVapidDetails("mailto:coach-app@example.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

function parseSubscriptions(raw) {
  const j = JSON.parse(raw);
  return Array.isArray(j) ? j : [j];
}

// 저녁 cron('30 11 * * *')이면 evening, 그 외(아침 cron 또는 수동 실행 기본값)는 morning
function resolveSlot() {
  if (FORCED_SLOT === "morning" || FORCED_SLOT === "evening") return FORCED_SLOT;
  return GH_SCHEDULE.includes("11") ? "evening" : "morning";
}

function buildPayload(slot) {
  if (slot === "morning") {
    return { title: "✍️ 오늘의 코칭 세션", body: "오늘의 글쓰기·말하기 과제가 기다리고 있어요.", slot: "morning" };
  }
  return {
    title: "⚠️ 오늘 아직 세션 전이에요",
    body: "자기 전에 딱 한 세션만 — 5분이면 충분해요.",
    slot: "evening",
    praise: { title: "✅ 오늘도 완료!", body: "내일도 이 페이스 그대로 가봐요." }
  };
}

async function main() {
  const slot = resolveSlot();
  const payload = JSON.stringify(buildPayload(slot));
  const subs = parseSubscriptions(RAW_SUBSCRIPTIONS);
  console.log(`슬롯: ${slot} · 구독 ${subs.length}건에 발송 시도`);

  let ok = 0, gone = 0, failed = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload);
      ok++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        gone++;   // 구독이 만료/해지됨 — 정상적인 상황, 에러로 취급하지 않는다
        console.log(`구독 만료(${e.statusCode}): ${sub.endpoint.slice(0, 60)}...`);
      } else {
        failed++;
        console.error(`발송 실패(${e.statusCode || "?"}): ${e.message}`);
      }
    }
  }
  console.log(`완료 — 성공 ${ok} · 만료 ${gone} · 실패 ${failed}`);
  if (failed > 0 && ok === 0) process.exit(1);
}

main();
