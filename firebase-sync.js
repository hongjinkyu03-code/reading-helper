// ─────────────────────────────────────────────────────────
// 구글 로그인 + 클라우드 자동 동기화 (Firebase, 무료 Spark 플랜)
// app.js는 이 파일을 몰라도 됩니다. window.dokseoBridge를 통해서만 연결됩니다.
// ─────────────────────────────────────────────────────────
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getDatabase, ref, set, get, onValue,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";

// ⚠️ 여기에 Firebase 콘솔에서 복사한 firebaseConfig를 붙여넣으세요.
// (프로젝트 설정 → 내 앱 → 웹 앱 → SDK 설정 및 구성)
const firebaseConfig = {
  apiKey: "AIzaSyDHi5cz-rdrK4Bro2wHL71QvpKarYiuZ9s",
  authDomain: "reading-helper-4de4f.firebaseapp.com",
  projectId: "reading-helper-4de4f",
  storageBucket: "reading-helper-4de4f.firebasestorage.app",
  messagingSenderId: "157452571335",
  appId: "1:157452571335:web:bfb89975ec2e8a41d3a4e2",
};

let auth, db, currentUid = null;
let applyingRemote = false;      // 클라우드→로컬 반영 중에는 다시 클라우드로 안 쏘기 위한 잠금
let pushTimer = null;            // 저장이 여러 번 연달아 일어나도 클라우드엔 한 번만 보내기(디바운스)
let unsubscribeSnapshot = null;

function ready() {
  return firebaseConfig.apiKey && firebaseConfig.apiKey !== "REPLACE_ME";
}

function setStatus(text) {
  const el = document.getElementById("sync-status");
  if (el) el.textContent = text;
}

function showSignedIn(user) {
  document.getElementById("sync-signed-out")?.classList.add("hidden");
  document.getElementById("sync-signed-in")?.classList.remove("hidden");
  const info = document.getElementById("sync-user-info");
  if (info) info.textContent = `✅ ${user.displayName || user.email}님으로 로그인됨 — 자동 저장 중`;
}

function showSignedOut() {
  document.getElementById("sync-signed-out")?.classList.remove("hidden");
  document.getElementById("sync-signed-in")?.classList.add("hidden");
}

async function pushToCloud(state) {
  if (!currentUid || applyingRemote) return;
  try {
    await set(ref(db, "users/" + currentUid), {
      data: state,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    setStatus("⚠️ 클라우드 저장 실패(인터넷 연결을 확인해 주세요): " + e.message);
  }
}

function startListening(uid) {
  const userRef = ref(db, "users/" + uid);
  unsubscribeSnapshot = onValue(userRef, (snap) => {
    if (!snap.exists()) return;
    const cloud = snap.val().data;
    if (!cloud) return;
    applyingRemote = true;
    window.dokseoBridge.applyRemote(cloud);
    applyingRemote = false;
  });
}

async function handleSignedIn(user) {
  currentUid = user.uid;
  showSignedIn(user);
  setStatus("클라우드 기록을 불러오는 중…");
  try {
    const snap = await get(ref(db, "users/" + user.uid));
    if (snap.exists() && snap.val().data) {
      // 첫 로그인 시: 클라우드에 있던 기록 + 이 기기에 있던 기록을 합칩니다.
      applyingRemote = true;
      window.dokseoBridge.mergeIncoming(snap.val().data);
      applyingRemote = false;
      // 합친 결과를 클라우드에도 반영
      await pushToCloud(window.dokseoBridge.getState());
    } else {
      // 클라우드에 아직 기록이 없으면, 이 기기의 기록을 첫 업로드
      await pushToCloud(window.dokseoBridge.getState());
    }
    setStatus("✅ 동기화됐어요! 다른 기기에서 같은 구글 계정으로 로그인하면 이 기록이 그대로 이어져요.");
  } catch (e) {
    setStatus("⚠️ 불러오기 실패: " + e.message);
  }
  startListening(user.uid);

  // 이 시점부터: app.js가 saveState()를 부를 때마다 클라우드에도 자동 저장(디바운스)
  window.dokseoBridge.onLocalSave = (state) => {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => pushToCloud(state), 1200);
  };
}

function handleSignedOut() {
  currentUid = null;
  showSignedOut();
  setStatus("");
  if (unsubscribeSnapshot) { unsubscribeSnapshot(); unsubscribeSnapshot = null; }
  if (window.dokseoBridge) window.dokseoBridge.onLocalSave = null;
}

function init() {
  if (!ready()) {
    // 아직 firebaseConfig를 안 채웠으면 조용히 대기 (로컬 저장은 평소대로 동작)
    setStatus("");
    const btn = document.getElementById("sync-signin");
    if (btn) btn.addEventListener("click", () => {
      setStatus("⚠️ 아직 클라우드 동기화 설정이 끝나지 않았어요. (관리자에게 문의)");
    });
    return;
  }

  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getDatabase(app);

  onAuthStateChanged(auth, (user) => {
    if (user) handleSignedIn(user); else handleSignedOut();
  });

  document.getElementById("sync-signin")?.addEventListener("click", async () => {
    setStatus("로그인 창을 여는 중…");
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (e) {
      setStatus("⚠️ 로그인 실패: " + e.message);
    }
  });

  document.getElementById("sync-signout")?.addEventListener("click", async () => {
    await signOut(auth);
  });
}

// app.js가 window.dokseoBridge를 만들 때까지 기다렸다가 시작
function waitForBridgeThenInit() {
  if (window.dokseoBridge) { init(); return; }
  const t = setInterval(() => {
    if (window.dokseoBridge) { clearInterval(t); init(); }
  }, 50);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", waitForBridgeThenInit);
} else {
  waitForBridgeThenInit();
}
