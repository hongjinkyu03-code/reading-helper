// 서비스 워커: 방문한 파일을 저장해뒀다가 인터넷이 없을 때 대신 보여주고,
// 앱이 닫혀 있을 때도 백그라운드에서 독서 알림을 시도합니다.
// 캐시 전략: "네트워크 우선" - 온라인이면 항상 최신 파일, 오프라인이면 저장본 사용
importScripts("quotes.js"); // FAMOUS_QUOTES 명언 목록 공유

const CACHE_NAME = "dokseo-v6";
const ASSETS = ["./", "./index.html", "./style.css", "./app.js", "./quotes.js", "./manifest.json"];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ===== 백그라운드 독서 알림 =====
// 앱(app.js)이 IndexedDB에 복사해 둔 알림 설정을 읽어서,
// 브라우저가 이 워커를 깨워줄 때마다 알림 시간이 지났는지 확인합니다
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("dokseo", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const req = db.transaction("kv").objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function maybeNotifyInBackground() {
  const s = await idbGet("settings");
  if (!s || !s.notifyEnabled) return;

  const now = new Date();
  const today = now.getFullYear() + "-" +
    String(now.getMonth() + 1).padStart(2, "0") + "-" +
    String(now.getDate()).padStart(2, "0");
  const hhmm = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");

  if (hhmm >= s.notifyTime && s.lastNotified !== today) {
    s.lastNotified = today;
    await idbSet("settings", s);
    const q = FAMOUS_QUOTES[Math.floor(Math.random() * FAMOUS_QUOTES.length)];
    await self.registration.showNotification("📖 오늘의 독서 시간이에요!", {
      body: `“${q.text}” — ${q.by}`,
      icon: "icon-192.png",
      badge: "icon-192.png",
      tag: "daily-reading",
    });
  }
}

// ===== 진짜 푸시 수신 (GitHub Actions가 보낸 알림) =====
// 앱이 완전히 닫혀 있어도 이 이벤트는 실행됩니다
self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let data = { title: "📖 오늘의 독서 시간이에요!", body: "책 한 페이지 어때요?" };
    try {
      if (event.data) data = event.data.json();
    } catch (e) { /* 형식이 다르면 기본 문구 사용 */ }

    // 밤 알림(스트릭 경고)은 폰에 저장된 기록을 확인해서,
    // 오늘 이미 읽었으면 잔소리 대신 칭찬 메시지로 바꿔서 보여줌
    if (data.slot === "night" && data.praise) {
      try {
        const stats = await idbGet("reading-stats");
        const now = new Date();
        const today = now.getFullYear() + "-" +
          String(now.getMonth() + 1).padStart(2, "0") + "-" +
          String(now.getDate()).padStart(2, "0");
        if (stats && stats.lastLogDate === today) data = data.praise;
      } catch (e) { /* 기록을 못 읽으면 원래 메시지 그대로 */ }
    }

    await self.registration.showNotification(data.title, {
      body: data.body,
      icon: "icon-192.png",
      badge: "icon-192.png",
      tag: "daily-reading",
    });
  })());
});

self.addEventListener("periodicsync", event => {
  if (event.tag === "daily-reading-reminder") {
    event.waitUntil(maybeNotifyInBackground());
  }
});

// 알림을 누르면 열려 있는 앱 창으로 이동하거나 새로 엶
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      return clients.openWindow("./");
    })
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
