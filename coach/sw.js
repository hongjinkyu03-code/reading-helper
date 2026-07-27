/* service worker — 오프라인 캐시 (앱 셸)
   캐시 전략: "네트워크 우선" — 온라인이면 항상 최신 파일, 오프라인이면 저장본 사용.
   (예전엔 캐시 우선이라, 홈 화면에 설치해 거의 안 닫는 아이폰 앱에서는
   서버에 새 버전을 올려도 화면이 몇 주씩 갱신되지 않는 문제가 있었다.) */
const CACHE = "coach-v19";
const ASSETS = [
  "./",
  "./index.html",
  "./coach.css",
  "./coach.js",
  "./curriculum.js",
  "./situations.js",
  "./quality.js",
  "./drills.js",
  "./speech.js",
  "./story.js",
  "./manifest.json",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  // Gemini/Anthropic API 등 외부 요청은 캐시하지 않음
  if (!req.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then((cached) => cached || caches.match("./index.html")))
  );
});

/* ===== 학습 알림 (듀오링고식 스트릭 독촉) =====
   coach.js가 IndexedDB(coachdb/notify)에 복사해 둔 설정을 읽어서,
   브라우저가 이 워커를 깨워줄 때마다 알림 시간이 지났는지 확인한다. */
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("coachdb", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbSet(key, value) {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  }));
}
function idbGet(key) {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const req = db.transaction("kv").objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  }));
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function buildNotify(slot, notify) {
  const doneToday = !!notify.doneToday;
  const streak = notify.streak || 0;
  if (slot === "morning") {
    if (doneToday) return null;
    return { title: streak > 0 ? `🔥 ${streak}일째 연속 학습 중!` : "✍️ 오늘의 코칭 세션", body: "오늘의 글쓰기·말하기 과제가 기다리고 있어요." };
  }
  if (doneToday) return { title: `✅ 오늘도 완료! ${streak}일 연속`, body: "내일도 이 페이스 그대로 가봐요." };
  return { title: streak > 0 ? `⚠️ ${streak}일 연속 기록이 끊기기 직전이에요` : "🌙 오늘 아직 세션 전이에요", body: "자기 전에 딱 한 세션만 — 5분이면 충분해요." };
}
async function maybeNotifyInBackground() {
  const stored = await idbGet("notify");
  if (!stored || !stored.settings || !stored.settings.enabled) return;
  const n = stored.settings;
  const now = new Date();
  const hhmm = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  const today = todayStr();
  // 이 워커가 깨어 있는 동안엔 stored.doneToday가 오늘 값 그대로일 수 있으니, 날짜가 바뀌었으면 미완료로 취급
  const doneToday = stored.today === today ? stored.doneToday : false;
  let changed = false;
  if (hhmm >= n.morning && n.lastMorning !== today) {
    n.lastMorning = today; changed = true;
    const msg = buildNotify("morning", { doneToday, streak: stored.streak });
    if (msg) await self.registration.showNotification(msg.title, { body: msg.body, icon: "icon-192.png", badge: "icon-192.png", tag: "coach-morning" });
  }
  if (hhmm >= n.evening && n.lastEvening !== today) {
    n.lastEvening = today; changed = true;
    const msg = buildNotify("evening", { doneToday, streak: stored.streak });
    if (msg) await self.registration.showNotification(msg.title, { body: msg.body, icon: "icon-192.png", badge: "icon-192.png", tag: "coach-evening" });
  }
  if (changed) await idbSet("notify", stored);
}

/* ===== 진짜 푸시 수신 — 앱이 완전히 닫혀 있어도 이 이벤트는 실행된다 ===== */
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let data = { title: "✍️ 오늘의 코칭 세션", body: "오늘의 글쓰기·말하기 과제가 기다리고 있어요.", slot: "morning" };
    try { if (event.data) data = event.data.json(); } catch (e) { /* 형식이 다르면 기본 문구 사용 */ }
    // 서버는 오늘 세션 여부를 모른다 — 폰에 저장된 기록으로만 판단할 수 있다.
    let doneToday = false;
    try {
      const stored = await idbGet("notify");
      doneToday = !!(stored && stored.today === todayStr() && stored.doneToday);
    } catch (e) { /* 못 읽으면 안 한 것으로 취급 — 과잉 알림이 무알림보다 낫다 */ }
    if (data.slot === "morning" && doneToday) return;   // 아침엔 이미 했으면 조용히 넘어간다
    if (data.slot === "evening" && doneToday && data.praise) data = data.praise;   // 저녁엔 잔소리 대신 칭찬
    await self.registration.showNotification(data.title, {
      body: data.body, icon: "icon-192.png", badge: "icon-192.png", tag: "coach-" + (data.slot || "push")
    });
  })());
});

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "coach-daily-reminder") event.waitUntil(maybeNotifyInBackground());
});
