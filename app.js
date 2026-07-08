// ===== 장르 정의 =====
// 장르마다 고유 색을 정해두고, 배지와 밸런스 그래프에 같은 색을 사용합니다
const GENRES = {
  "소설": "#d9534f",
  "고전": "#8e6cc0",
  "에세이": "#e8963c",
  "인문": "#2f9e9e",
  "철학": "#5b6abf",
  "역사": "#a67c52",
  "과학": "#3b82c4",
  "경제·경영": "#2f9e6e",
  "자기계발": "#d4699e",
  "기타": "#8a8f98",
};
function genreColor(g) { return GENRES[g] || GENRES["기타"]; }
// 색 뒤에 "1a"를 붙이면 같은 색의 연한(투명한) 버전이 됩니다 → 배지 배경용
function genreBadge(g) {
  const name = GENRES[g] ? g : "기타";
  const c = genreColor(name);
  return `<span class="genre-badge" style="background:${c}1a;color:${c}">${name}</span>`;
}
function genreDot(g) {
  return `<i class="genre-dot" style="background:${genreColor(g)}"></i>`;
}

// 유명한 독서 명언은 quotes.js에서 불러옵니다 (FAMOUS_QUOTES)

// ===== 데이터 저장/불러오기 =====
// 모든 데이터는 브라우저의 localStorage에 저장됩니다 (서버 없음, 이 기기 안에만 저장)
const STORAGE_KEY = "dokseo-data";

let state = loadState();

function loadState() {
  let data = { books: [], logs: [] };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) data = JSON.parse(raw);
  } catch (e) { /* 손상된 데이터면 새로 시작 */ }
  // 예전 버전 데이터에 새 항목이 없으면 채워주기 (마이그레이션)
  if (!data.quotes) data.quotes = [];
  if (!data.settings) data.settings = { notifyEnabled: false, notifyTime: "21:00", lastNotified: null };
  if (!data.actions) {
    data.actions = [];
    // 이미 완독 질문에 답해둔 '실천해볼 것'이 있으면 실천 약속 목록으로 가져오기
    (data.books || []).forEach(b => {
      if (b.review && b.review.action) {
        data.actions.push({
          id: b.id + "-act", bookId: b.id, text: b.review.action,
          done: false, addedAt: b.review.date || null,
        });
      }
    });
  }
  return data;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// 날짜를 "2026-07-06" 형태 문자열로 변환
function dateStr(d) {
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}
function todayStr() { return dateStr(new Date()); }

// ===== 탭 전환 =====
document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
  });
});

// ===== 책 추가 =====
document.getElementById("book-form").addEventListener("submit", e => {
  e.preventDefault();
  const title = document.getElementById("book-title").value.trim();
  if (!title) return;
  state.books.push({
    id: uid(),
    title: title,
    author: document.getElementById("book-author").value.trim(),
    genre: document.getElementById("book-genre").value,
    totalPages: Number(document.getElementById("book-pages").value) || null,
    status: document.getElementById("book-status").value, // reading | queue | done
    addedAt: todayStr(),
    finishedAt: null,
  });
  saveState();
  e.target.reset();
  render();
});

// ===== 독서 기록 추가 =====
document.getElementById("log-form").addEventListener("submit", e => {
  e.preventDefault();
  const pages = Number(document.getElementById("log-pages").value) || 0;
  const minutes = Number(document.getElementById("log-minutes").value) || 0;
  if (pages === 0 && minutes === 0) {
    alert("쪽수나 시간 중 하나는 입력해 주세요!");
    return;
  }
  state.logs.push({
    id: uid(),
    bookId: document.getElementById("log-book").value,
    date: todayStr(),
    pages: pages,
    minutes: minutes,
    memo: document.getElementById("log-memo").value.trim(),
  });
  saveState();
  e.target.reset();
  render();
});

// ===== 문장 수집 =====
document.getElementById("quote-form").addEventListener("submit", e => {
  e.preventDefault();
  const text = document.getElementById("quote-text").value.trim();
  if (!text) return;
  const bookVal = document.getElementById("quote-book").value;
  state.quotes.push({
    id: uid(),
    bookId: bookVal === "_custom" ? null : bookVal,
    source: bookVal === "_custom" ? document.getElementById("quote-source").value.trim() : "",
    text: text,
    page: Number(document.getElementById("quote-page").value) || null,
    addedAt: todayStr(),
  });
  saveState();
  e.target.reset();
  render();
});

// "직접 입력"을 고르면 책 이름 입력칸이 나타남
document.getElementById("quote-book").addEventListener("change", e => {
  document.getElementById("quote-source-wrap").classList.toggle("hidden", e.target.value !== "_custom");
});

function deleteQuote(id) {
  if (!confirm("이 문장을 삭제할까요?")) return;
  state.quotes = state.quotes.filter(q => q.id !== id);
  saveState();
  render();
}

// ===== 책 상태 바꾸기 / 삭제 =====
function startReading(id) {
  const book = state.books.find(b => b.id === id);
  if (book) { book.status = "reading"; saveState(); render(); }
}

// '완독!'을 누르면 바로 완독 처리하지 않고, 세 가지 질문 모달을 먼저 보여줌
let reviewingBookId = null;

function finishBook(id) {
  reviewingBookId = id;
  document.getElementById("review-sentence").value = "";
  document.getElementById("review-changed").value = "";
  document.getElementById("review-action").value = "";
  document.getElementById("review-overlay").classList.add("show");
}

function completeReview(withAnswers) {
  const book = state.books.find(b => b.id === reviewingBookId);
  if (!book) return;
  book.status = "done";
  book.finishedAt = todayStr();

  if (withAnswers) {
    const sentence = document.getElementById("review-sentence").value.trim();
    const changed = document.getElementById("review-changed").value.trim();
    const action = document.getElementById("review-action").value.trim();
    if (sentence || changed || action) {
      book.review = { sentence, changed, action, date: todayStr() };
    }
    // 기억에 남는 문장은 '모아둔 문장'에도 자동 저장 → 오늘의 문장으로 다시 만나게 됨
    if (sentence) {
      state.quotes.push({
        id: uid(), bookId: book.id, source: "", text: sentence, page: null, addedAt: todayStr(),
      });
    }
    // '실천해볼 것'은 실천 약속 체크리스트에도 자동 추가
    if (action) {
      state.actions.push({
        id: uid(), bookId: book.id, text: action, done: false, addedAt: todayStr(),
      });
    }
  }
  document.getElementById("review-overlay").classList.remove("show");
  reviewingBookId = null;
  saveState();
  render();
}

document.getElementById("review-save").addEventListener("click", () => completeReview(true));
document.getElementById("review-skip").addEventListener("click", () => completeReview(false));
function deleteBook(id) {
  const book = state.books.find(b => b.id === id);
  if (!book) return;
  if (!confirm(`'${book.title}' 책과 그 책의 독서 기록을 모두 삭제할까요?`)) return;
  state.books = state.books.filter(b => b.id !== id);
  state.logs = state.logs.filter(l => l.bookId !== id);
  saveState();
  render();
}
function deleteLog(id) {
  if (!confirm("이 기록을 삭제할까요?")) return;
  state.logs = state.logs.filter(l => l.id !== id);
  saveState();
  render();
}

// ===== 화면 그리기 =====
function render() {
  renderStats();
  renderTodayQuote();
  renderLogForm();
  renderActions();
  renderBalance();
  renderHeatmap();
  renderBooks();
  renderQuotes();
  renderLogs();
}

// ===== 실천 약속 =====
document.getElementById("action-form").addEventListener("submit", e => {
  e.preventDefault();
  const text = document.getElementById("action-text").value.trim();
  if (!text) return;
  state.actions.push({ id: uid(), bookId: null, text, done: false, addedAt: todayStr() });
  saveState();
  e.target.reset();
  render();
});

function toggleAction(id) {
  const a = state.actions.find(a => a.id === id);
  if (a) { a.done = !a.done; saveState(); render(); }
}
function deleteAction(id) {
  if (!confirm("이 실천 약속을 삭제할까요?")) return;
  state.actions = state.actions.filter(a => a.id !== id);
  saveState();
  render();
}

function renderActions() {
  const el = document.getElementById("action-list");
  if (state.actions.length === 0) {
    el.innerHTML = `<p class="empty-msg">완독할 때 '실천해볼 것'을 적으면<br>여기에 체크리스트로 모여요.</p>`;
    return;
  }
  // 아직 안 한 약속을 위로, 완료한 약속을 아래로
  const sorted = [...state.actions].sort((a, b) => a.done - b.done);
  el.innerHTML = sorted.map(a => {
    const book = state.books.find(b => b.id === a.bookId);
    return `
      <div class="action-item ${a.done ? "done" : ""}">
        <input type="checkbox" ${a.done ? "checked" : ""} onchange="toggleAction('${a.id}')">
        <span class="action-text">${escapeHtml(a.text)}
          ${book ? `<span class="action-src">📕 ${escapeHtml(book.title)}</span>` : ""}
        </span>
        <button class="btn-small danger" onclick="deleteAction('${a.id}')">삭제</button>
      </div>`;
  }).join("");
}

// ===== 독서 타이머 =====
let timerTotal = 0;    // 처음 설정한 전체 초
let timerLeft = 0;     // 남은 초
let timerInterval = null;

const timerDisplay = document.getElementById("timer-display");
const timerStartBtn = document.getElementById("timer-start");
const timerPauseBtn = document.getElementById("timer-pause");
const timerMinInput = document.getElementById("timer-minutes");
const timerHint = document.getElementById("timer-hint");

function fmtTime(sec) {
  return String(Math.floor(sec / 60)).padStart(2, "0") + ":" + String(sec % 60).padStart(2, "0");
}

timerStartBtn.addEventListener("click", () => {
  if (timerLeft === 0) {
    const min = Math.max(1, Math.min(180, Number(timerMinInput.value) || 20));
    timerTotal = min * 60;
    timerLeft = timerTotal;
  }
  timerInterval = setInterval(timerTick, 1000);
  timerStartBtn.classList.add("hidden");
  timerPauseBtn.classList.remove("hidden");
  timerDisplay.classList.add("running");
  timerHint.classList.remove("done");
  timerHint.textContent = "집중해서 읽는 중... 📖";
});

timerPauseBtn.addEventListener("click", () => {
  clearInterval(timerInterval);
  timerStartBtn.classList.remove("hidden");
  timerPauseBtn.classList.add("hidden");
  timerDisplay.classList.remove("running");
  timerHint.textContent = "일시정지 중이에요.";
});

document.getElementById("timer-reset").addEventListener("click", () => {
  clearInterval(timerInterval);
  timerLeft = 0;
  timerStartBtn.classList.remove("hidden");
  timerPauseBtn.classList.add("hidden");
  timerDisplay.classList.remove("running");
  timerDisplay.textContent = fmtTime((Number(timerMinInput.value) || 20) * 60);
  timerHint.classList.remove("done");
  timerHint.textContent = "타이머가 끝나면 읽은 시간이 위 기록 폼에 자동으로 채워져요.";
});

timerMinInput.addEventListener("input", () => {
  if (timerLeft === 0) timerDisplay.textContent = fmtTime((Number(timerMinInput.value) || 20) * 60);
});

function timerTick() {
  timerLeft--;
  timerDisplay.textContent = fmtTime(Math.max(0, timerLeft));
  if (timerLeft <= 0) {
    clearInterval(timerInterval);
    timerDone();
  }
}

function timerDone() {
  const minutes = Math.round(timerTotal / 60);
  timerStartBtn.classList.remove("hidden");
  timerPauseBtn.classList.add("hidden");
  timerDisplay.classList.remove("running");
  timerLeft = 0;
  // 읽은 시간을 기록 폼에 자동으로 채워주기
  document.getElementById("log-minutes").value = minutes;
  timerHint.classList.add("done");
  timerHint.textContent = `🎉 ${minutes}분 완료! 위 기록 폼에 시간을 채워뒀어요. '기록하기'를 눌러주세요.`;
  // 다른 탭을 보고 있어도 알 수 있게 알림도 함께 (권한이 있을 때만)
  if ("Notification" in window && Notification.permission === "granted") {
    navigator.serviceWorker.ready.then(reg =>
      reg.showNotification("⏱️ 독서 타이머 완료!", {
        body: `${minutes}분 독서 완료! 기록하는 것 잊지 마세요.`,
        icon: "icon-192.png",
        tag: "reading-timer",
      })
    );
  }
}

// ===== 오늘의 문장 (랜덤 복습) =====
// 수집한 문장이 있으면 그중에서, 없으면 유명한 명언 중에서 골라 보여줌
// 날짜를 숫자로 바꿔서 고르기 때문에 하루 동안은 같은 문장이 유지됨
function renderTodayQuote(shuffle = false) {
  const el = document.getElementById("today-quote");
  const mine = state.quotes;
  const pool = mine.length > 0 ? mine : FAMOUS_QUOTES;

  let idx;
  if (shuffle) {
    idx = Math.floor(Math.random() * pool.length);
  } else {
    let h = 0;
    for (const ch of todayStr()) h += ch.charCodeAt(0);
    idx = h % pool.length;
  }

  const q = pool[idx];
  let src, label;
  if (mine.length > 0) {
    src = quoteSource(q);
    label = "📌 내가 수집한 문장";
  } else {
    src = q.by;
    label = "✨ 유명한 독서 명언";
  }
  el.innerHTML = `
    <p class="quote-text">“${escapeHtml(q.text)}”</p>
    <p class="quote-src">— ${escapeHtml(src)}</p>
    <span class="quote-label">${label}</span>`;
}
document.getElementById("quote-shuffle").addEventListener("click", () => renderTodayQuote(true));

// 수집한 문장의 출처 문자열 만들기 (책 제목 + 쪽수)
function quoteSource(q) {
  const book = state.books.find(b => b.id === q.bookId);
  const name = book ? book.title : (q.source || "출처 미상");
  return name + (q.page ? `, ${q.page}쪽` : "");
}

// ===== 문장 탭 그리기 =====
function renderQuotes() {
  // 책 선택 목록: 등록된 모든 책 + 직접 입력
  const select = document.getElementById("quote-book");
  const prev = select.value;
  select.innerHTML =
    state.books.map(b => `<option value="${b.id}">${escapeHtml(b.title)}</option>`).join("") +
    `<option value="_custom">직접 입력 (책장에 없는 책)</option>`;
  if ([...select.options].some(o => o.value === prev)) select.value = prev;
  document.getElementById("quote-source-wrap").classList.toggle("hidden", select.value !== "_custom");

  // 모아둔 문장 목록 (최신순)
  const el = document.getElementById("quote-list");
  document.getElementById("quote-count").textContent =
    state.quotes.length ? `${state.quotes.length}개` : "";
  if (state.quotes.length === 0) {
    el.innerHTML = `<p class="empty-msg">아직 모은 문장이 없어요.<br>좋았던 문장을 저장하면 '오늘의 문장'으로 다시 만나요!</p>`;
    return;
  }
  el.innerHTML = [...state.quotes].reverse().map(q => {
    const book = state.books.find(b => b.id === q.bookId);
    return `
      <div class="quote-item">
        <p class="quote-text">“${escapeHtml(q.text)}”</p>
        <div class="quote-meta">
          <span>${book ? genreDot(book.genre) : ""}${escapeHtml(quoteSource(q))} · ${q.addedAt}</span>
          <button class="btn-small danger" onclick="deleteQuote('${q.id}')">삭제</button>
        </div>
      </div>`;
  }).join("");
}

// 장르 밸런스: 읽는 중 + 완독한 책을 장르별로 세서 색깔 막대로 표시
function renderBalance() {
  const el = document.getElementById("genre-balance");
  const counted = state.books.filter(b => b.status !== "queue");

  if (counted.length === 0) {
    el.innerHTML = `<p class="empty-msg">책을 읽기 시작하면<br>장르 분포가 여기에 표시돼요.</p>`;
    return;
  }

  const counts = {};
  counted.forEach(b => {
    const g = GENRES[b.genre] ? b.genre : "기타";
    counts[g] = (counts[g] || 0) + 1;
  });
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const total = counted.length;

  const bar = entries.map(([g, n]) =>
    `<div class="balance-seg" style="width:${(n / total * 100).toFixed(1)}%;background:${genreColor(g)}" title="${g} ${n}권"></div>`
  ).join("");

  const legend = entries.map(([g, n]) =>
    `<span>${genreDot(g)}${g} ${n}권</span>`
  ).join("");

  // 균형 힌트: 책이 3권 이상이고 한 장르가 절반 이상이면 다른 장르를 권해줌
  let tip = "";
  if (total >= 3) {
    const [topGenre, topCount] = entries[0];
    if (topCount / total >= 0.5) {
      const unread = Object.keys(GENRES).filter(g => g !== "기타" && !counts[g]);
      const suggest = unread.length
        ? ` 아직 안 읽어본 <b>${unread.slice(0, 2).join(", ")}</b>은 어때요?`
        : "";
      tip = `<p class="balance-tip">💡 지금은 <b>${topGenre}</b> 쪽으로 기울어 있어요.${suggest}</p>`;
    } else {
      tip = `<p class="balance-tip">👍 여러 장르를 골고루 읽고 있어요. 좋은 균형이에요!</p>`;
    }
  }

  el.innerHTML = `<div class="balance-bar">${bar}</div><div class="balance-legend">${legend}</div>${tip}`;
}

// 연속 기록(스트릭) + 오늘 읽은 쪽수
function renderStats() {
  const byDate = {};
  state.logs.forEach(l => { byDate[l.date] = true; });

  // 오늘부터 거꾸로 세면서 기록이 있는 날이 며칠 연속인지 계산
  // (오늘 아직 기록 안 했으면 어제부터 세어줌 - 아직 스트릭이 깨진 게 아니니까)
  let streak = 0;
  const cursor = new Date();
  if (!byDate[dateStr(cursor)]) cursor.setDate(cursor.getDate() - 1);
  while (byDate[dateStr(cursor)]) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  document.getElementById("streak-value").textContent = streak;

  const todayPages = state.logs
    .filter(l => l.date === todayStr())
    .reduce((sum, l) => sum + (l.pages || 0), 0);
  document.getElementById("today-pages").textContent = todayPages;

  // 백그라운드 알림(서비스 워커)이 '오늘 읽었는지' 알 수 있게 요약을 IndexedDB에 저장
  // → 밤 스트릭 경고 알림이 이미 읽은 날에는 칭찬으로 바뀜
  const lastLogDate = state.logs.reduce((max, l) => (l.date > max ? l.date : max), "");
  idbSet("reading-stats", { lastLogDate, streak }).catch(() => {});
}

// 홈의 기록 폼: "읽는 중"인 책만 선택 목록에 표시
function renderLogForm() {
  const readingBooks = state.books.filter(b => b.status === "reading");
  const select = document.getElementById("log-book");
  const formWrap = document.getElementById("log-form-wrap");
  const noBookMsg = document.getElementById("no-reading-book");

  if (readingBooks.length === 0) {
    formWrap.classList.add("hidden");
    noBookMsg.classList.remove("hidden");
    return;
  }
  formWrap.classList.remove("hidden");
  noBookMsg.classList.add("hidden");

  const prev = select.value;
  select.innerHTML = readingBooks
    .map(b => `<option value="${b.id}">${escapeHtml(b.title)}</option>`)
    .join("");
  if (readingBooks.some(b => b.id === prev)) select.value = prev;
}

// 잔디밭: 최근 16주를 GitHub 스타일 격자로
function renderHeatmap() {
  const activity = {}; // 날짜별 활동량 = 쪽수 + 분
  state.logs.forEach(l => {
    activity[l.date] = (activity[l.date] || 0) + (l.pages || 0) + (l.minutes || 0);
  });

  const today = new Date();
  const WEEKS = 16;
  // 시작일: (WEEKS-1)주 전 일요일 → 열이 주 단위로 딱 맞게 정렬됨
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay() - (WEEKS - 1) * 7);

  let html = "";
  const cursor = new Date(start);
  const todayS = todayStr();
  while (true) {
    const ds = dateStr(cursor);
    if (ds > todayS) break;
    const amount = activity[ds] || 0;
    let level = 0;
    if (amount >= 60) level = 4;
    else if (amount >= 40) level = 3;
    else if (amount >= 20) level = 2;
    else if (amount >= 1) level = 1;
    html += `<i class="cell l${level}" title="${ds}: ${amount}"></i>`;
    cursor.setDate(cursor.getDate() + 1);
  }
  document.getElementById("heatmap").innerHTML = html;
}

// 책장: 상태별 목록
function renderBooks() {
  renderBookList("list-reading", "reading");
  renderBookList("list-queue", "queue");
  renderBookList("list-done", "done");
}

function renderBookList(elementId, status) {
  const books = state.books.filter(b => b.status === status);
  const el = document.getElementById(elementId);

  if (books.length === 0) {
    const msgs = {
      reading: "읽는 중인 책이 없어요.",
      queue: "읽고 싶은 책을 미리 담아두세요!",
      done: "아직 완독한 책이 없어요.",
    };
    el.innerHTML = `<p class="empty-msg">${msgs[status]}</p>`;
    return;
  }

  el.innerHTML = books.map(b => {
    const readPages = state.logs
      .filter(l => l.bookId === b.id)
      .reduce((sum, l) => sum + (l.pages || 0), 0);

    let progress = "";
    if (status === "reading" && b.totalPages) {
      const pct = Math.min(100, Math.round((readPages / b.totalPages) * 100));
      progress = `
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="progress-text">${readPages} / ${b.totalPages}쪽 (${pct}%)</div>`;
    }

    let actions = "";
    if (status === "reading") {
      actions = `<button class="btn-small" onclick="finishBook('${b.id}')">완독!</button>`;
    } else if (status === "queue") {
      actions = `<button class="btn-small" onclick="startReading('${b.id}')">읽기 시작</button>`;
    }
    actions += `<button class="btn-small danger" onclick="deleteBook('${b.id}')">삭제</button>`;

    const meta = [b.author, status === "done" ? `완독일 ${b.finishedAt}` : null]
      .filter(Boolean).join(" · ");

    // 완독 시 답한 세 가지 질문 보여주기
    let review = "";
    if (status === "done" && b.review) {
      const lines = [
        b.review.sentence ? `<div>💬 ${escapeHtml(b.review.sentence)}</div>` : "",
        b.review.changed ? `<div>🌱 ${escapeHtml(b.review.changed)}</div>` : "",
        b.review.action ? `<div>✅ ${escapeHtml(b.review.action)}</div>` : "",
      ].join("");
      if (lines) review = `<div class="review-box">${lines}</div>`;
    }

    return `
      <div class="book-item">
        <div class="book-title">${escapeHtml(b.title)}${genreBadge(b.genre)}</div>
        ${meta ? `<div class="book-meta">${escapeHtml(meta)}</div>` : ""}
        ${progress}
        ${review}
        <div class="book-actions">${actions}</div>
      </div>`;
  }).join("");
}

// 기록 탭: 날짜별로 묶어서 최신순
function renderLogs() {
  const el = document.getElementById("log-list");
  if (state.logs.length === 0) {
    el.innerHTML = `<p class="empty-msg">아직 기록이 없어요.<br>홈에서 오늘의 독서를 기록해 보세요!</p>`;
    return;
  }

  const byDate = {};
  state.logs.forEach(l => {
    (byDate[l.date] = byDate[l.date] || []).push(l);
  });
  const dates = Object.keys(byDate).sort().reverse();

  el.innerHTML = dates.map(date => {
    const items = byDate[date].map(l => {
      const book = state.books.find(b => b.id === l.bookId);
      const detail = [
        l.pages ? `${l.pages}쪽` : null,
        l.minutes ? `${l.minutes}분` : null,
      ].filter(Boolean).join(" · ");
      return `
        <div class="log-item">
          <div class="log-info">
            <div class="log-book">${book ? genreDot(book.genre) : ""}${escapeHtml(book ? book.title : "(삭제된 책)")}</div>
            <div class="log-detail">${detail}</div>
            ${l.memo ? `<div class="log-memo">💬 ${escapeHtml(l.memo)}</div>` : ""}
          </div>
          <button class="btn-small danger" onclick="deleteLog('${l.id}')">삭제</button>
        </div>`;
    }).join("");
    return `<div class="log-date-group"><div class="log-date-title">${date}</div>${items}</div>`;
  }).join("");
}

// HTML에 넣을 때 특수문자를 안전하게 바꿔주는 함수 (보안 습관)
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

// ===== IndexedDB 도우미 =====
// localStorage는 서비스 워커(백그라운드)가 읽을 수 없어서,
// 알림 설정만은 서비스 워커도 읽을 수 있는 IndexedDB에 복사해 둡니다
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

// 설정이 바뀔 때마다 IndexedDB에도 복사
function syncSettingsToIdb() {
  idbSet("settings", { ...state.settings }).catch(() => {});
}

// 백그라운드 주기 동기화 등록 (설치된 PWA + 크롬/엣지에서만 동작)
// 브라우저가 틈틈이 서비스 워커를 깨워서 알림 시간을 확인하게 해줌
async function setupPeriodicSync() {
  try {
    const reg = await navigator.serviceWorker.ready;
    if ("periodicSync" in reg) {
      await reg.periodicSync.register("daily-reading-reminder", {
        minInterval: 60 * 60 * 1000, // 최소 1시간 간격으로 확인 기회 요청
      });
    }
  } catch (e) { /* 미지원 브라우저나 권한 없음 → 앱이 열려 있을 때 방식으로만 동작 */ }
}

// ===== 독서 알림 =====
// 정해둔 시간이 지나면 하루 한 번, 유명한 구절과 함께 알림을 보냅니다.
// 앱이 열려 있으면 아래 30초 체크로, 닫혀 있으면 서비스 워커의 주기 동기화로 시도합니다.
const notifyTimeInput = document.getElementById("notify-time");
const notifyToggleBtn = document.getElementById("notify-toggle");
const notifyStatusEl = document.getElementById("notify-status");

function updateNotifyUI() {
  const s = state.settings;
  notifyTimeInput.value = s.notifyTime;
  if (s.notifyEnabled && Notification.permission === "granted") {
    notifyToggleBtn.textContent = "알림 끄기";
    notifyStatusEl.textContent = `✅ 매일 ${s.notifyTime}에 알림이 와요 (앱이나 브라우저가 켜져 있을 때)`;
    notifyStatusEl.classList.add("on");
  } else {
    notifyToggleBtn.textContent = "알림 켜기";
    notifyStatusEl.textContent = "알림이 꺼져 있어요.";
    notifyStatusEl.classList.remove("on");
  }
}

notifyToggleBtn.addEventListener("click", async () => {
  if (!("Notification" in window)) {
    notifyStatusEl.textContent = "이 브라우저는 알림을 지원하지 않아요.";
    return;
  }
  if (state.settings.notifyEnabled) {
    state.settings.notifyEnabled = false;
  } else {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      notifyStatusEl.textContent = "⚠️ 알림이 차단되어 있어요. 브라우저 설정에서 이 사이트의 알림을 허용해 주세요.";
      return;
    }
    state.settings.notifyEnabled = true;
    state.settings.notifyTime = notifyTimeInput.value || "21:00";
    setupPeriodicSync();
  }
  saveState();
  syncSettingsToIdb();
  updateNotifyUI();
});

notifyTimeInput.addEventListener("change", () => {
  state.settings.notifyTime = notifyTimeInput.value || "21:00";
  saveState();
  syncSettingsToIdb();
  updateNotifyUI();
});

// 알림에 넣을 문구: 유명한 명언 하나 + 독서 권유
function buildNotification() {
  const q = FAMOUS_QUOTES[Math.floor(Math.random() * FAMOUS_QUOTES.length)];
  return {
    title: "📖 오늘의 독서 시간이에요!",
    body: `“${q.text}” — ${q.by}`,
  };
}

async function showReadingNotification() {
  const msg = buildNotification();
  const reg = await navigator.serviceWorker.ready;
  reg.showNotification(msg.title, {
    body: msg.body,
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: "daily-reading", // 같은 태그면 알림이 중복으로 쌓이지 않음
  });
}

// '미리 보기' 버튼: 권한을 받고 즉시 알림을 한 번 보여줌
document.getElementById("notify-test").addEventListener("click", async () => {
  if (!("Notification" in window)) {
    notifyStatusEl.textContent = "이 브라우저는 알림을 지원하지 않아요.";
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    notifyStatusEl.textContent = "⚠️ 알림이 차단되어 있어요. 브라우저 설정에서 허용해 주세요.";
    return;
  }
  showReadingNotification();
});

// ===== 진짜 푸시 알림 (앱이 닫혀 있어도 수신) =====
// GitHub Actions가 매일 정해진 시간에 이 열쇠(공개키)로 서명된 푸시를 보내줍니다.
// 폰에서 '연결하기'를 누르면 나오는 구독 코드를 비공개 저장소에 등록해야 완성돼요.
const VAPID_PUBLIC_KEY = "BFvXwKWN0IysNTmk4TX89fH9SGJEZitR8OtHvcIrqbrYpXwhsjwHti-r03-QkjpH0cUcpk2usCBbsqEf9hDRvaA";

// 푸시 구독에 필요한 형태(바이트 배열)로 공개키를 변환
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(ch => ch.charCodeAt(0)));
}

const pushStatusEl = document.getElementById("push-status");

document.getElementById("push-subscribe").addEventListener("click", async () => {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    pushStatusEl.textContent =
      "⚠️ 이 브라우저에서는 푸시를 쓸 수 없어요. 아이폰이라면 사파리에서 '홈 화면에 추가'로 설치한 앱에서 눌러주세요. (iOS 16.4 이상)";
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      pushStatusEl.textContent = "⚠️ 알림 권한이 거부됐어요. 설정에서 이 앱의 알림을 허용해 주세요.";
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
    document.getElementById("push-json").value = JSON.stringify(sub.toJSON());
    document.getElementById("push-result").classList.remove("hidden");
    pushStatusEl.textContent = "✅ 구독 생성 완료! 위 코드를 복사해서 클로드에게 붙여넣어 주세요.";
  } catch (e) {
    pushStatusEl.textContent = "⚠️ 구독 생성 실패: " + e.message;
  }
});

document.getElementById("push-copy").addEventListener("click", async () => {
  const textarea = document.getElementById("push-json");
  textarea.select();
  try {
    await navigator.clipboard.writeText(textarea.value);
    pushStatusEl.textContent = "📋 복사됐어요! 클로드에게 붙여넣어 주세요.";
  } catch (e) {
    document.execCommand("copy"); // 구형 방식 (클립보드 API가 막힌 경우)
    pushStatusEl.textContent = "📋 복사됐어요! 클로드에게 붙여넣어 주세요.";
  }
});

// 30초마다 시간을 확인해서, 설정한 시간이 지났고 오늘 아직 안 보냈으면 알림 발송
function checkNotification() {
  const s = state.settings;
  if (!s.notifyEnabled) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const now = new Date();
  const hhmm = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  if (hhmm >= s.notifyTime && s.lastNotified !== todayStr()) {
    s.lastNotified = todayStr();
    saveState();
    syncSettingsToIdb();
    showReadingNotification();
  }
}
setInterval(checkNotification, 30 * 1000);

// ===== 시작 =====
// 장르 선택 목록 채우기 (GENRES에 장르를 추가하면 자동으로 여기에도 나타남)
document.getElementById("book-genre").innerHTML =
  Object.keys(GENRES).map(g => `<option value="${g}">${g}</option>`).join("");

document.getElementById("today-date").textContent =
  new Date().toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "short" });

render();
updateNotifyUI();

// PWA: 서비스 워커 등록 (오프라인 지원 + 홈 화면 설치 가능하게)
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").then(async () => {
    // 백그라운드에서 알림을 보냈다면(IndexedDB에 기록됨) localStorage 쪽에도 반영해서 중복 방지
    try {
      const idbSettings = await idbGet("settings");
      if (idbSettings && idbSettings.lastNotified &&
          idbSettings.lastNotified > (state.settings.lastNotified || "")) {
        state.settings.lastNotified = idbSettings.lastNotified;
        saveState();
      }
    } catch (e) { /* 무시 */ }
    syncSettingsToIdb();
    if (state.settings.notifyEnabled) setupPeriodicSync();
    checkNotification();
  });
}
