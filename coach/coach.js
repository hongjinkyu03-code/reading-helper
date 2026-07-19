/* ============================================================================
 * coach.js — 글쓰기·말하기 코치 세션 엔진
 * 프롬프트의 코칭 철학을 상태 머신으로 구현한다.
 *   Day N 진행 · 기술 순환 + 간격 반복 · 자기 주목(noticing) · 재도전 ·
 *   인출 요약 · 약점(자기평가) 추적 · 선택적 AI 피드백.
 * 모든 데이터는 localStorage 에만 저장된다.
 * ========================================================================== */
(function () {
  "use strict";

  const LS_KEY = "coachState_v1";
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  /* 트랙 순환 패턴 (Day 2부터): 쓰기4 · 말하기2 · 복습1 = 7일 주기 */
  const TRACK_PATTERN = ["write", "write", "speak", "write", "write", "speak", "review"];

  /* ----------------------------- 상태 ----------------------------- */
  function defaultState() {
    return {
      version: 1,
      onboarded: false,
      goals: "",
      currentDay: 0,          // 지금까지 시작한 마지막 Day
      activeSession: null,    // 진행 중 세션(새로고침에도 유지)
      sessions: [],           // 완료된 세션 기록
      skills: {},             // { skillId: {rating:1..3, seen, lastDay} }
      ptr: { write: 0, speak: 0 },
      streak: 0,
      lastCompletedDate: null,
      activity: {},           // { 'YYYY-MM-DD': count }
      lastWeeklyReviewDay: 0,
      settings: { apiKey: "", model: "claude-sonnet-5", aiEnabled: false }
    };
  }
  let state = load();
  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return defaultState();
      return Object.assign(defaultState(), JSON.parse(raw));
    } catch (e) { return defaultState(); }
  }
  function save() { localStorage.setItem(LS_KEY, JSON.stringify(state)); }

  /* ----------------------------- 날짜 ----------------------------- */
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function dateNDaysAgo(n) {
    const d = new Date(); d.setDate(d.getDate() - n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  /* -------------------- 텍스트 지표(오프라인 피드백용) -------------------- */
  function charLen(t) { return (t || "").trim().length; }
  function splitSentences(t) {
    return (t || "").split(/[.!?。…]+|\n+/).map(s => s.trim()).filter(Boolean);
  }
  function countMatches(t, re) { const m = (t || "").match(re); return m ? m.length : 0; }
  function metrics(t) {
    const sents = splitSentences(t);
    const lens = sents.map(charLen);
    return {
      chars: charLen(t),
      sentences: sents.length,
      lens,
      longest: lens.length ? Math.max(...lens) : 0,
      shortest: lens.length ? Math.min(...lens) : 0,
      fillers: countMatches(t, /것(?![가-힣])|수\s*있|에\s*대(해|하여|한)|라고\s*생각|인\s*것\s*같|매우|정말|너무|좀|약간/g),
      passives: countMatches(t, /되었|되어|되는|어졌|아졌|여졌|당하|지어/g),
      connectors: countMatches(t, /그리고|그래서|하지만|그러나|또한|그런데|따라서|그러므로/g),
      emotionWords: countMatches(t, /행복|슬프|슬픔|기쁘|기쁨|감동|좋았|힘들|즐거|재미있|아름답|설레/g)
    };
  }

  /* -------------------- 오프라인(자기 주목형) 피드백 -------------------- */
  /* AI 없이도 '구체적 관찰 + 스스로 발견 질문'을 제공한다(주목 가설).       */
  function localObservation(lesson, text) {
    const m = metrics(text);
    let obs = [];
    switch (lesson.id) {
      case "concision":
        obs.push(`글자 수 <b>${m.chars}자</b>, 군더더기 후보 표현 <b>${m.fillers}회</b> 감지.`);
        obs.push(m.fillers > 3 ? "빼도 뜻이 사는 표현이 아직 남아 있을 가능성이 높아요." : "군더더기를 잘 걷어냈네요. 한 번 더 훑어보세요.");
        break;
      case "active-voice":
        obs.push(`피동 표현 <b>${m.passives}회</b> 감지, 문장 <b>${m.sentences}개</b>.`);
        obs.push(m.passives > 1 ? "피동 문장에 '누가 한 일인지' 물어보세요." : "행위자가 대체로 잘 드러나 있어요.");
        break;
      case "sentence-rhythm":
        obs.push(`문장 길이(글자): <b>${m.lens.join(", ") || "-"}</b>. 가장 긺 ${m.longest}, 가장 짧음 ${m.shortest}.`);
        obs.push((m.longest - m.shortest) < 12 ? "길이 편차가 작아요. 하나를 아주 짧게 쳐 보세요." : "길이 변주가 살아 있어요. 핵심 문장이 가장 짧은가요?");
        break;
      case "connectors":
        obs.push(`접속사 <b>${m.connectors}회</b> 사용, 문장 <b>${m.sentences}개</b>.`);
        obs.push(m.connectors > 0 ? "접속사를 빼도 흐름이 유지되는지 시험해 보세요." : "접속사 없이 이었네요. 내용으로 연결됐는지 확인해 보세요.");
        break;
      case "concreteness":
        obs.push(`감정·평가 단어 <b>${m.emotionWords}회</b> 감지.`);
        obs.push(m.emotionWords > 0 ? "그 단어를 '그 순간 본/들은 것'으로 바꿔 보세요." : "추상어를 잘 피했어요. 감각이 두 가지 이상 들어갔나요?");
        break;
      case "topic-first": case "one-idea": case "structure": case "argument": case "audience":
        obs.push(`문단/문장 구성: 문장 <b>${m.sentences}개</b>, ${m.chars}자.`);
        obs.push("첫 문장만 따로 읽어보세요 — 전체가 예측되나요?");
        break;
      default:
        obs.push(`분량 <b>${m.chars}자</b>, 문장 <b>${m.sentences}개</b>.`);
        obs.push("아래 질문으로 스스로 점검해 보세요.");
    }
    return obs.join(" ");
  }

  /* ----------------------------- 스케줄러 ----------------------------- */
  const WRITE_POOL = CURRICULUM.filter(l => l.track === "write");
  const SPEAK_POOL = CURRICULUM.filter(l => l.track === "speak");
  const byId = (id) => CURRICULUM.find(l => l.id === id);

  function trackForDay(day) {
    if (day <= 1) return "diagnostic";
    return TRACK_PATTERN[(day - 2) % TRACK_PATTERN.length];
  }

  function weakestSkill(track) {
    // rating===1(더 필요) 인 기술 중 가장 오래전에 다룬 것 (간격 반복 인출)
    const pool = track === "speak" ? SPEAK_POOL : WRITE_POOL;
    const weak = pool
      .filter(l => state.skills[l.id] && state.skills[l.id].rating === 1)
      .sort((a, b) => (state.skills[a.id].lastDay || 0) - (state.skills[b.id].lastDay || 0));
    return weak[0] || null;
  }

  function pickLesson(day, track) {
    const pool = track === "speak" ? SPEAK_POOL : WRITE_POOL;
    // 3일마다, 그리고 약점이 있으면 약점을 다시 꺼내 인출 연습
    if (day % 3 === 0) {
      const w = weakestSkill(track);
      if (w) return w;
    }
    // 아직 안 다룬 것 우선, 그다음 가장 오래전에 다룬 것
    const sorted = [...pool].sort((a, b) => {
      const sa = state.skills[a.id], sb = state.skills[b.id];
      const da = sa ? (sa.lastDay || 0) : -1, db = sb ? (sb.lastDay || 0) : -1;
      return da - db;
    });
    return sorted[0] || pool[state.ptr[track] % pool.length];
  }

  function buildReviewLesson(day) {
    // 최근 다룬 서로 다른 기술 2~3개를 통합하는 과제 생성
    const recent = [];
    for (let i = state.sessions.length - 1; i >= 0 && recent.length < 3; i--) {
      const s = state.sessions[i];
      if (s.track === "review") continue;
      const l = byId(s.lessonId);
      if (l && !recent.find(r => r.id === l.id)) recent.push(l);
    }
    const skills = recent.length ? recent.map(l => l.skill) : ["두괄식 구성", "간결성", "구체성"];
    return {
      id: "review-" + day, track: "review", category: "복습·통합", skill: "이번 주 기술 통합",
      goal: "이번 주에 배운 기술들을 한 편의 글에서 동시에 사용한다.",
      why: "따로 익힌 기술을 한데 모아 쓸 때 비로소 내 것이 된다(전이). 통합 과제는 배운 것을 인출해 실전에 옮기는 훈련이다.",
      bad: "기술을 하나씩만 신경 쓰다 글 전체가 따로 노는 상태.",
      good: "두괄식으로 열고, 간결한 문장으로, 구체적 장면까지 — 여러 기술이 한 글에 자연스럽게 녹은 상태.",
      lesson: `이번 주에 연습한 <b>${esc(skills.join(" · "))}</b> 를 모두 의식하며 한 편의 글을 쓰세요. 하나를 챙기다 다른 걸 놓치기 쉬우니, 초고를 쓴 뒤 기술별로 한 번씩 훑어 고치는 게 요령입니다.`,
      task: "자유 주제로 한 편의 완결된 짧은 글을 쓰되, 이번 주에 배운 기술을 최대한 담으세요.",
      constraints: ["300자 내외의 완결된 글", "이번 주 기술 중 최소 2가지를 의식적으로 적용", "제출 후 어떤 기술을 어디에 썼는지 한 줄로 표시"],
      time: "20~25분",
      noticing: ["초고를 이번 주 기술 목록으로 하나씩 점검해 보세요. 빠뜨린 기술이 있나요?", "여러 기술을 챙기느라 글의 흐름이 어색해진 곳은 없나요?"],
      hints: ["한 번에 한 기술씩 보며 고치면 놓치지 않습니다.", "가장 자신 있는 기술부터 확실히 적용하세요."],
      retry: "가장 약하게 적용된 기술 하나를 골라, 그 부분만 다시 쓰세요.",
      _reviewSkills: skills
    };
  }

  /* ----------------------------- 세션 시작 ----------------------------- */
  function startNextSession() {
    const day = state.currentDay + 1;
    const track = trackForDay(day);
    let lesson;
    if (track === "review") lesson = buildReviewLesson(day);
    else lesson = pickLesson(day, track);

    const sess = {
      day, lessonId: lesson.id, track: lesson.track,
      category: lesson.category, skill: lesson.skill,
      stage: "brief", submission: "", noticed: "", retry: "",
      aiFeedback: "", aiRetryFeedback: "", summary: "", selfRating: null,
      _lesson: lesson.track === "review" ? lesson : null // 복습 레슨은 동적이라 저장
    };
    if (lesson.track === "speak") {
      sess.topic = SPEAK_TOPICS[Math.floor(Math.random() * SPEAK_TOPICS.length)];
    }
    state.currentDay = day;
    state.activeSession = sess;
    save();
    renderToday();
  }

  function lessonOf(sess) {
    if (sess._lesson) return sess._lesson;
    return byId(sess.lessonId) || buildReviewLesson(sess.day);
  }

  function lastLearnedLine() {
    for (let i = state.sessions.length - 1; i >= 0; i--) {
      const s = state.sessions[i];
      if (s.summary) return `Day ${s.day} · ${esc(s.skill)} — “${esc(s.summary)}”`;
      if (s.skill) return `Day ${s.day} · ${esc(s.skill)}`;
    }
    return null;
  }

  /* ============================ 렌더링 ============================ */
  function renderAll() {
    renderHeader();
    renderToday();
    renderProgress();
    renderLog();
    renderSettings();
  }

  function renderHeader() {
    const el = $("#header-day");
    if (!state.onboarded) { el.textContent = "진단 전"; return; }
    const active = state.activeSession;
    el.textContent = active ? `Day ${active.day}` : `Day ${state.currentDay}`;
  }

  /* ------------------------ 오늘 탭 (세션) ------------------------ */
  function renderToday() {
    renderHeader();
    const root = $("#session-root");
    if (!state.onboarded) { root.innerHTML = viewDiagnostic(); wireDiagnostic(); return; }
    const sess = state.activeSession;
    if (!sess) { root.innerHTML = viewStart(); wireStart(); return; }

    const stageViews = {
      brief: [viewBrief, wireBrief],
      write: [viewWrite, wireWrite],
      notice: [viewNotice, wireNotice],
      feedback: [viewFeedback, wireFeedback],
      retry: [viewRetry, wireRetry],
      wrap: [viewWrap, wireWrap],
      done: [viewDone, wireDone]
    };
    const [view, wire] = stageViews[sess.stage] || stageViews.brief;
    root.innerHTML = view(sess, lessonOf(sess));
    wire(sess, lessonOf(sess));
  }

  /* ---- 진단 (Day 1) ---- */
  function viewDiagnostic() {
    const prompt = DIAGNOSTIC_PROMPTS[Math.floor(Math.random() * DIAGNOSTIC_PROMPTS.length)];
    return `
    <div class="session-step welcome">
      <span class="step-kicker">DAY 1 · 진단</span>
      <h2>글쓰기·말하기 마스터 코치를 시작합니다</h2>
      <p class="lead">막연한 반복이 아니라, 당신의 약점을 정확히 겨냥한 과제를 매일 설계합니다.
      먼저 현재 실력을 진단하고, 목표에 맞춰 첫 주 커리큘럼을 제안할게요.</p>

      <div class="card" style="margin-top:14px">
        <label>① 어떤 글이나 말을 잘하고 싶나요? <span class="muted">(목표를 자세히 적을수록 커리큘럼이 정확해져요)</span>
          <textarea id="diag-goal" rows="3" placeholder="예: 업무 보고를 간결하게 쓰고 싶다 / 발표에서 논리적으로 말하고 싶다 / 에세이를 쓰고 싶다"></textarea>
        </label>
        <label style="margin-top:16px">② 자유 주제로 300자 정도 글을 써 주세요.
          <span class="muted">추천 주제: “${esc(prompt)}” (원하는 주제로 바꿔도 좋아요)</span>
          <textarea id="diag-text" rows="9" placeholder="편하게, 지금 떠오르는 대로 써 주세요. 평소 문체가 가장 좋은 진단 자료예요."></textarea>
        </label>
        <div class="char-count" id="diag-count">0자</div>
        <button class="btn primary" id="diag-submit">진단 제출하고 커리큘럼 받기</button>
      </div>
    </div>`;
  }
  function wireDiagnostic() {
    const ta = $("#diag-text"), cc = $("#diag-count");
    ta.addEventListener("input", () => { cc.textContent = charLen(ta.value) + "자"; });
    $("#diag-submit").addEventListener("click", () => {
      const goal = $("#diag-goal").value.trim();
      const text = ta.value.trim();
      if (charLen(text) < 100) { alert("진단을 위해 100자 이상 써 주세요. 편하게 쓰면 됩니다!"); return; }
      state.goals = goal;
      state.onboarded = true;
      state.currentDay = 1;
      state.sessions.push({
        day: 1, lessonId: "diagnostic", track: "write", category: "진단",
        skill: "진단 글쓰기", submission: text, noticed: "", retry: "",
        summary: "", selfRating: null, date: todayStr()
      });
      recordActivity();
      save();
      renderAll();
      switchTab("tab-today");
    });
  }

  /* ---- 세션 시작 화면 ---- */
  function viewStart() {
    const nextDay = state.currentDay + 1;
    const track = trackForDay(nextDay);
    const trackName = { write: "글쓰기", speak: "말하기", review: "복습·통합" }[track] || "";
    const recall = lastLearnedLine();
    const doneToday = state.activity[todayStr()] ? true : false;
    // 첫 주 커리큘럼 미리보기 (진단 직후)
    let preview = "";
    if (state.currentDay === 1) {
      const plan = [];
      for (let d = 2; d <= 8; d++) {
        const t = trackForDay(d);
        const nm = { write: "✍️ 글쓰기", speak: "🎙️ 말하기", review: "🔁 복습·통합" }[t];
        plan.push(`<li><b>Day ${d}</b> · ${nm}</li>`);
      }
      preview = `
      <div class="card">
        <h2>🗺️ 제안하는 첫 주 커리큘럼</h2>
        <p class="muted small">쓰기 4일 · 말하기 2일 · 복습 1일의 리듬으로 순환합니다. 진행하며 당신의 약점에 맞게 자동 조정돼요.</p>
        <ul style="margin:8px 0 0; padding-left:18px; font-size:14px; line-height:1.9">${plan.join("")}</ul>
      </div>`;
    }
    return `
    <div class="session-step">
      ${recall ? `<div class="recall-line">🔁 지난 세션: <b>${recall}</b></div>` : ""}
      ${preview}
      <div class="card" style="text-align:center; padding:26px 18px">
        <div class="step-kicker ${track}">DAY ${nextDay} · ${trackName}</div>
        <h2 style="margin:6px 0 4px">오늘의 과제를 시작할까요?</h2>
        <p class="muted small">${doneToday ? "오늘 이미 한 세션을 마쳤어요. 더 하고 싶다면 이어서 진행해도 좋아요 💪" : "10~20분이면 충분해요. 살짝 버거운 게 정상입니다."}</p>
        <button class="btn primary" id="start-session" style="max-width:280px; margin:16px auto 0">Day ${nextDay} 시작하기</button>
      </div>
    </div>`;
  }
  function wireStart() {
    $("#start-session").addEventListener("click", startNextSession);
  }

  /* ---- brief: 목표·미니레슨·과제 ---- */
  function viewBrief(sess, L) {
    const trackName = { write: "글쓰기", speak: "말하기", review: "복습·통합" }[L.track];
    const recall = lastLearnedLine();
    const examplePair = (L.bad || L.good) ? `
      <div class="example-pair">
        ${L.bad ? `<div class="ex bad"><span class="tag">✗ 이렇게 말고</span>${esc(L.bad)}</div>` : ""}
        ${L.good ? `<div class="ex good"><span class="tag">✓ 이렇게</span>${esc(L.good)}</div>` : ""}
      </div>` : "";
    const topic = sess.topic ? `<div class="topic-highlight">🎤 오늘의 주제: ${esc(sess.topic)}</div>` : "";
    return `
    <div class="session-step">
      <span class="step-kicker ${L.track}">DAY ${sess.day} · ${trackName}</span>
      ${recall ? `<div class="recall-line">🔁 지난 세션: <b>${recall}</b></div>` : ""}

      <div class="goal-box">
        <span class="lbl">🎯 오늘의 목표 · ${esc(L.skill)}</span>
        <p>${esc(L.goal)}</p>
      </div>

      <div class="section-label">왜 이 기술인가</div>
      <p class="why-text">${esc(L.why)}</p>

      ${examplePair}

      <div class="section-label">미니 레슨</div>
      <div class="lesson-text">${L.lesson}</div>

      <div class="section-label">오늘의 과제</div>
      ${topic}
      <div class="task-box">
        <div class="task-title">📝 ${esc(L.task)}</div>
        <ul class="constraints">${(L.constraints || []).map(c => `<li>${esc(c)}</li>`).join("")}</ul>
        <span class="time-pill">⏱️ 권장 ${esc(L.time || "10~20분")}</span>
      </div>
      <button class="btn primary" id="to-write">작성 시작하기</button>
    </div>`;
  }
  function wireBrief(sess) {
    $("#to-write").addEventListener("click", () => { sess.stage = "write"; save(); renderToday(); });
  }

  /* ---- write: 제출 (말하기는 타이머) ---- */
  function viewWrite(sess, L) {
    const limit = extractCharLimit(L.constraints);
    const timer = L.speak && (L.speak.prepSec || L.speak.speakSec) ? viewTimer(L) : "";
    const speakHint = L.track === "speak"
      ? `<p class="muted small">말로 먼저 해본 뒤, 말한 내용을 아래에 옮기거나 요약해 적어 주세요.</p>` : "";
    return `
    <div class="session-step">
      <span class="step-kicker ${L.track}">DAY ${sess.day} · 작성</span>
      <div class="goal-box"><span class="lbl">🎯 ${esc(L.skill)}</span><p>${esc(L.goal)}</p></div>
      ${sess.topic ? `<div class="topic-highlight">🎤 ${esc(sess.topic)}</div>` : ""}
      <div class="section-label">지켜야 할 제약</div>
      <ul class="constraints">${(L.constraints || []).map(c => `<li>${esc(c)}</li>`).join("")}</ul>
      ${timer}
      ${speakHint}
      <label style="margin-top:14px">✍️ 여기에 작성하세요
        <textarea id="submit-text" rows="10" data-limit="${limit || 0}" placeholder="${L.track === "speak" ? "말한 내용을 옮겨 적기…" : "과제를 여기에 작성하세요…"}">${esc(sess.submission)}</textarea>
      </label>
      <div class="char-count" id="submit-count">0자</div>
      <button class="btn primary" id="submit-btn">제출하기</button>
      <button class="btn ghost small" id="back-brief">← 레슨 다시 보기</button>
    </div>`;
  }
  function wireWrite(sess) {
    const ta = $("#submit-text"), cc = $("#submit-count");
    const limit = parseInt(ta.getAttribute("data-limit"), 10) || 0;
    const upd = () => {
      const n = charLen(ta.value);
      cc.textContent = limit ? `${n} / ${limit}자` : `${n}자`;
      cc.classList.toggle("over", !!limit && n > limit);
    };
    ta.addEventListener("input", () => { sess.submission = ta.value; upd(); });
    upd();
    if (lessonOf(sess).speak && $("#tm-start")) setupTimer();
    $("#submit-btn").addEventListener("click", () => {
      if (charLen(ta.value) < 20) { alert("조금 더 써 주세요 (최소 20자). 짧아도 좋으니 완성해 봅시다!"); return; }
      sess.submission = ta.value.trim();
      sess.stage = "notice"; stopTimer(); save(); renderToday();
    });
    $("#back-brief").addEventListener("click", () => { sess.stage = "brief"; stopTimer(); save(); renderToday(); });
  }

  /* ---- 말하기 타이머 ---- */
  function viewTimer(L) {
    const prep = L.speak.prepSec, speak = L.speak.speakSec;
    if (!prep && !speak) return "";
    return `
    <div class="card" style="margin-top:14px">
      <div class="timer-wrap">
        <div class="timer-phase" id="tm-phase">준비 시간</div>
        <div class="timer-display prep" id="tm-display">${fmt(prep || speak)}</div>
        <div class="timer-controls">
          <button class="btn small btn-secondary" id="tm-start">▶ 준비 시작</button>
          <button class="btn small ghost" id="tm-reset">초기화</button>
        </div>
      </div>
      <p class="muted small" style="text-align:center; margin:6px 0 0">준비 ${prep}초 → 말하기 ${speak}초. 소리 내어 실제로 말해 보세요.</p>
    </div>`;
  }
  let _timerId = null, _timerState = null;
  function setupTimer() {
    const L = lessonOf(state.activeSession);
    if (!L.speak) return;
    const startBtn = $("#tm-start"), resetBtn = $("#tm-reset");
    if (!startBtn) return;
    _timerState = { phase: "prep", remain: L.speak.prepSec || L.speak.speakSec, prep: L.speak.prepSec, speak: L.speak.speakSec };
    startBtn.addEventListener("click", () => {
      if (_timerId) return;
      startBtn.textContent = "진행 중…"; startBtn.disabled = true;
      _timerId = setInterval(tick, 1000);
    });
    resetBtn.addEventListener("click", stopTimer);
  }
  function tick() {
    const s = _timerState, disp = $("#tm-display"), phase = $("#tm-phase");
    if (!disp) { stopTimer(); return; }
    s.remain--;
    if (s.remain <= 0) {
      if (s.phase === "prep" && s.speak) {
        s.phase = "speak"; s.remain = s.speak;
        phase.textContent = "🎤 말하기!"; disp.classList.remove("prep");
        if (navigator.vibrate) navigator.vibrate(200);
      } else {
        disp.textContent = "완료!"; disp.classList.add("done");
        phase.textContent = "수고했어요 — 이제 옮겨 적으세요";
        if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
        stopTimer(true); return;
      }
    }
    disp.textContent = fmt(s.remain);
  }
  function stopTimer(keepDisplay) {
    if (_timerId) { clearInterval(_timerId); _timerId = null; }
    const btn = $("#tm-start");
    if (btn && !keepDisplay) {
      btn.textContent = "▶ 준비 시작"; btn.disabled = false;
      if (_timerState) { const d = $("#tm-display"); if (d) { d.textContent = fmt(_timerState.prep || _timerState.speak); d.className = "timer-display prep"; } const p = $("#tm-phase"); if (p) p.textContent = "준비 시간"; }
    }
  }
  window.__coachTimer = true;
  function fmt(sec) { const m = Math.floor(sec / 60), s = sec % 60; return `${m}:${String(s).padStart(2, "0")}`; }

  /* ---- notice: 자기 주목 ---- */
  function viewNotice(sess, L) {
    return `
    <div class="session-step">
      <span class="step-kicker ${L.track}">DAY ${sess.day} · 스스로 발견하기</span>
      <p class="muted small">피드백을 보기 전에, 먼저 스스로 살펴봅니다. 답을 바로 받기보다
      차이를 직접 알아차릴 때 실력이 자랍니다(주목 가설).</p>

      <div class="section-label">내가 쓴 글</div>
      <div class="ai-answer">${esc(sess.submission)}</div>

      <div class="section-label">스스로 점검할 질문</div>
      ${(L.noticing || []).map(q => `<div class="notice-q">🔎 ${esc(q)}</div>`).join("")}

      <label style="margin-top:14px">발견한 점을 적어보세요 <span class="muted">(선택)</span>
        <textarea id="noticed-text" rows="3" placeholder="예: 두 번째 문장이 너무 길고, 접속사에 기댔다">${esc(sess.noticed)}</textarea>
      </label>
      <button class="btn primary" id="to-feedback">확인했어요 · 피드백 받기</button>
    </div>`;
  }
  function wireNotice(sess) {
    $("#noticed-text").addEventListener("input", (e) => { sess.noticed = e.target.value; });
    $("#to-feedback").addEventListener("click", () => {
      sess.noticed = $("#noticed-text").value.trim();
      sess.stage = "feedback"; save(); renderToday();
    });
  }

  /* ---- feedback ---- */
  function viewFeedback(sess, L) {
    const useAI = state.settings.aiEnabled && state.settings.apiKey;
    const observation = localObservation(L, sess.submission);
    const aiSlot = useAI
      ? `<div class="fb-block fb-improve"><span class="fb-h">🤖 AI 코치 피드백</span>
           <div id="ai-fb"><span class="spinner"></span>피드백을 준비하고 있어요…</div></div>`
      : "";
    return `
    <div class="session-step">
      <span class="step-kicker ${L.track}">DAY ${sess.day} · 피드백</span>

      <div class="fb-block fb-praise">
        <span class="fb-h">👏 오늘의 노력</span>
        과제의 제약(${esc((L.constraints || [])[0] || "조건")})을 지키며 끝까지 완성했어요.
        ${sess.noticed ? "게다가 스스로 문제를 짚어낸 점이 특히 좋습니다 — 그게 성장의 핵심이에요." : "완성 자체가 산출(output) 훈련이에요."}
      </div>

      <div class="fb-block fb-improve">
        <span class="fb-h">🎯 오늘 기술 관점의 관찰</span>
        ${observation}
      </div>

      <div class="section-label">개선 방향 (최대 2가지)</div>
      ${(L.hints || []).slice(0, 2).map(h => `<div class="notice-q">→ ${esc(h)}</div>`).join("")}

      ${aiSlot}

      <div class="fb-block" style="background:#f6f7fe;border:1px solid var(--line)">
        <span class="fb-h" style="color:var(--primary)">✏️ 다음 재도전</span>
        ${esc(L.retry)}
      </div>

      <button class="btn primary" id="to-retry">그 부분만 다시 쓰기</button>
      <button class="btn ghost small" id="skip-retry">재도전 건너뛰기</button>
    </div>`;
  }
  function wireFeedback(sess, L) {
    $("#to-retry").addEventListener("click", () => { sess.stage = "retry"; save(); renderToday(); });
    $("#skip-retry").addEventListener("click", () => { sess.stage = "wrap"; save(); renderToday(); });
    if (state.settings.aiEnabled && state.settings.apiKey) {
      if (sess.aiFeedback) { const el = $("#ai-fb"); if (el) el.innerHTML = esc(sess.aiFeedback); }
      else requestAIFeedback(sess, L, sess.submission, "first");
    }
  }

  /* ---- retry ---- */
  function viewRetry(sess, L) {
    return `
    <div class="session-step">
      <span class="step-kicker ${L.track}">DAY ${sess.day} · 재도전</span>
      <div class="fb-block" style="background:#f6f7fe;border:1px solid var(--line)">
        <span class="fb-h" style="color:var(--primary)">✏️ 재도전 과제</span>${esc(L.retry)}
      </div>
      <div class="section-label">참고 · 처음 쓴 글</div>
      <div class="ai-answer">${esc(sess.submission)}</div>
      <label style="margin-top:14px">🔁 고쳐 쓴 부분
        <textarea id="retry-text" rows="6" placeholder="피드백을 반영해 해당 부분만 다시 써 보세요">${esc(sess.retry)}</textarea>
      </label>
      <button class="btn primary" id="retry-submit">재도전 제출</button>
      ${state.settings.aiEnabled && state.settings.apiKey ? `<div id="ai-retry-slot"></div>` : ""}
    </div>`;
  }
  function wireRetry(sess, L) {
    $("#retry-text").addEventListener("input", (e) => { sess.retry = e.target.value; });
    $("#retry-submit").addEventListener("click", () => {
      sess.retry = $("#retry-text").value.trim();
      if (charLen(sess.retry) < 5) { alert("고쳐 쓴 내용을 조금 더 적어 주세요."); return; }
      sess.stage = "wrap"; save(); renderToday();
    });
  }

  /* ---- wrap: 자기평가 + 인출 요약 ---- */
  function viewWrap(sess, L) {
    return `
    <div class="session-step">
      <span class="step-kicker ${L.track}">DAY ${sess.day} · 마무리</span>

      <div class="section-label">오늘 이 기술, 얼마나 익혔나요? <span class="muted">(다음 과제 난이도 조절에 쓰여요)</span></div>
      <div class="timer-controls" style="justify-content:stretch; gap:8px; margin-top:8px">
        <button class="btn ghost small rate" data-r="1" style="flex:1;margin:0">😥 아직 어려워요</button>
        <button class="btn ghost small rate" data-r="2" style="flex:1;margin:0">🙂 그럭저럭</button>
        <button class="btn ghost small rate" data-r="3" style="flex:1;margin:0">😎 편해졌어요</button>
      </div>
      <p class="notify-status" id="rate-status"></p>

      <div class="section-label" style="margin-top:18px">오늘 배운 것을 한 문장으로 <span class="muted">(인출 연습 — 직접 말해봐야 남아요)</span></div>
      <textarea id="wrap-summary" rows="2" placeholder="예: 핵심 주장을 문단 맨 앞에 두면 글이 또렷해진다">${esc(sess.summary)}</textarea>

      <button class="btn primary" id="finish-session">세션 마무리</button>
    </div>`;
  }
  function wireWrap(sess, L) {
    $$(".rate").forEach(b => b.addEventListener("click", () => {
      sess.selfRating = parseInt(b.getAttribute("data-r"), 10);
      $$(".rate").forEach(x => x.style.background = "");
      b.style.background = "var(--primary-soft)";
      const msg = { 1: "약점 목록에 넣어 며칠 뒤 다시 연습해요.", 2: "곧 편해질 거예요. 반복이 답입니다.", 3: "좋아요! 다음엔 난이도를 한 단계 올릴게요(비계 제거)." }[sess.selfRating];
      $("#rate-status").textContent = msg;
      $("#rate-status").className = "notify-status ok";
    }));
    $("#finish-session").addEventListener("click", () => {
      sess.summary = $("#wrap-summary").value.trim();
      finishSession(sess, L);
    });
  }

  function finishSession(sess, L) {
    // 기술 자기평가 기록 (ZPD 비계 조절)
    if (L.track !== "review" && L.id) {
      const prev = state.skills[L.id] || { rating: 0, seen: 0, lastDay: 0 };
      state.skills[L.id] = {
        rating: sess.selfRating || prev.rating || 2,
        seen: prev.seen + 1,
        lastDay: sess.day
      };
    }
    state.ptr[sess.track === "speak" ? "speak" : "write"] = (state.ptr[sess.track === "speak" ? "speak" : "write"] || 0) + 1;
    const record = {
      day: sess.day, lessonId: sess.lessonId, track: sess.track,
      category: sess.category, skill: sess.skill, topic: sess.topic || "",
      submission: sess.submission, noticed: sess.noticed, retry: sess.retry,
      summary: sess.summary, selfRating: sess.selfRating, date: todayStr()
    };
    state.sessions.push(record);
    state.activeSession = null;
    recordActivity();
    save();
    // 7일마다 주간 리뷰
    maybeWeeklyReview();
    renderAll();
    switchTab("tab-today");
    // done 화면
    state._justFinished = record;
    $("#session-root").innerHTML = viewDone(record);
    wireDone();
  }

  function viewDone(rec) {
    const total = state.sessions.filter(s => s.lessonId !== "diagnostic").length;
    return `
    <div class="session-step">
      <div class="card" style="text-align:center; padding:28px 18px">
        <div style="font-size:40px">✅</div>
        <h2 style="margin:8px 0 4px">Day ${rec.day} 완료!</h2>
        <p class="muted small">${esc(rec.skill)}</p>
        ${rec.summary ? `<div class="recall-line" style="text-align:left;margin-top:14px">📌 오늘의 한 줄: <b>${esc(rec.summary)}</b></div>` : ""}
        <p class="muted small" style="margin-top:14px">지금까지 <b>${total}</b>개의 세션을 완료했어요. 🔥 연속 ${state.streak}일</p>
        <button class="btn primary" id="done-next" style="max-width:280px;margin:16px auto 0">다음 세션 준비</button>
        <button class="btn ghost small" id="done-progress">진도 보기</button>
      </div>
    </div>`;
  }
  function wireDone() {
    const n = $("#done-next"); if (n) n.addEventListener("click", () => { renderToday(); });
    const p = $("#done-progress"); if (p) p.addEventListener("click", () => switchTab("tab-progress"));
  }

  /* ------------------------ 활동/스트릭 ------------------------ */
  function recordActivity() {
    const t = todayStr();
    state.activity[t] = (state.activity[t] || 0) + 1;
    if (state.lastCompletedDate === t) { /* 같은 날 추가 세션 — 스트릭 유지 */ }
    else if (state.lastCompletedDate === dateNDaysAgo(1)) state.streak += 1;
    else state.streak = 1;
    state.lastCompletedDate = t;
  }

  /* ------------------------ 주간 리뷰 ------------------------ */
  function maybeWeeklyReview() {
    const done = state.sessions.filter(s => s.lessonId !== "diagnostic").length;
    if (done > 0 && done % 7 === 0) state.lastWeeklyReviewDay = state.currentDay;
    save();
  }

  /* ============================ 진도 탭 ============================ */
  function renderProgress() {
    $("#stat-day").textContent = state.currentDay;
    $("#stat-streak").textContent = state.streak;
    $("#stat-done").textContent = state.sessions.filter(s => s.lessonId !== "diagnostic").length;

    const g = $("#progress-goals");
    g.textContent = state.goals || "아직 목표를 설정하지 않았어요.";
    g.className = state.goals ? "" : "muted";

    // 기술 그리드
    const grid = $("#skill-grid");
    const all = CURRICULUM;
    grid.innerHTML = all.map(l => {
      const sk = state.skills[l.id];
      const cls = !sk ? "d-none" : sk.rating === 1 ? "d-weak" : sk.rating === 2 ? "d-mid" : sk.rating >= 3 ? "d-strong" : "d-none";
      return `<div class="skill-chip"><span class="sname">${esc(l.skill.split(" — ")[0])}</span><span class="dot ${cls}"></span></div>`;
    }).join("");

    renderHeatmap();
    renderWeeklyReview();
  }

  function renderHeatmap() {
    const el = $("#heatmap");
    const weeks = 12, cells = weeks * 7;
    // 오늘이 포함된 주의 마지막 요일까지 채우기 위해 today 기준 역산
    let html = "";
    const today = new Date();
    const start = new Date(today); start.setDate(today.getDate() - (cells - 1));
    for (let i = 0; i < cells; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const c = state.activity[key] || 0;
      const lvl = c === 0 ? "" : c === 1 ? "l1" : c === 2 ? "l2" : c === 3 ? "l3" : "l4";
      html += `<div class="cell ${lvl}" title="${key}: ${c}회"></div>`;
    }
    el.innerHTML = html;
  }

  function renderWeeklyReview() {
    const card = $("#weekly-review-card"), body = $("#weekly-review-body");
    const done = state.sessions.filter(s => s.lessonId !== "diagnostic").length;
    if (done < 7) { card.style.display = "none"; return; }
    card.style.display = "block";
    const strong = CURRICULUM.filter(l => state.skills[l.id] && state.skills[l.id].rating >= 3).map(l => l.skill.split(" — ")[0]);
    const weak = CURRICULUM.filter(l => state.skills[l.id] && state.skills[l.id].rating === 1).map(l => l.skill.split(" — ")[0]);
    body.innerHTML = `
      <p class="muted small">완료 세션 <b>${done}</b>개 · 연속 <b>${state.streak}</b>일</p>
      <div class="fb-block fb-praise"><span class="fb-h">🌱 편해진 기술 (난이도 ↑ 예정)</span>${strong.length ? esc(strong.join(", ")) : "아직 없어요 — 반복하면 곧 생깁니다."}</div>
      <div class="fb-block fb-improve"><span class="fb-h">🎯 더 연습할 기술 (과제에 다시 등장)</span>${weak.length ? esc(weak.join(", ")) : "표시된 약점이 없어요. 세션 마무리에서 솔직히 자기평가해 보세요."}</div>
      <p class="muted small">코치는 편해진 기술은 비계를 줄이고, 약점은 더 자주 꺼내 인출 연습시킵니다.</p>`;
  }

  /* ============================ 기록 탭 ============================ */
  function renderLog() {
    const el = $("#log-list");
    const list = [...state.sessions].reverse();
    if (!list.length) { el.innerHTML = `<p class="empty-msg">아직 기록이 없어요. 오늘 탭에서 첫 세션을 시작해 보세요!</p>`; return; }
    el.innerHTML = list.map((s, idx) => {
      const tb = s.track === "speak" ? "tb-speak" : s.track === "review" ? "tb-review" : "tb-write";
      const tn = s.track === "speak" ? "말하기" : s.track === "review" ? "복습" : s.lessonId === "diagnostic" ? "진단" : "글쓰기";
      const body = [
        s.topic ? `🎤 주제: ${s.topic}` : "",
        s.submission ? `【작성】\n${s.submission}` : "",
        s.noticed ? `\n【스스로 발견】\n${s.noticed}` : "",
        s.retry ? `\n【재도전】\n${s.retry}` : "",
        s.summary ? `\n📌 한 줄 요약: ${s.summary}` : ""
      ].filter(Boolean).join("\n");
      return `
      <div class="log-item" data-i="${idx}">
        <div class="lh">
          <span class="lday">Day ${s.day}</span>
          <span><span class="track-badge ${tb}">${tn}</span> <span class="ldate">${esc(s.date || "")}</span></span>
        </div>
        <div class="lskill">${esc(s.skill)}</div>
        <div class="lbody">${esc(body)}</div>
      </div>`;
    }).join("");
    $$(".log-item", el).forEach(it => it.addEventListener("click", () => it.classList.toggle("open")));
  }

  /* ============================ 설정 탭 ============================ */
  function renderSettings() {
    $("#set-apikey").value = state.settings.apiKey || "";
    $("#set-model").value = state.settings.model || "claude-sonnet-5";
    $("#set-ai-enabled").checked = !!state.settings.aiEnabled;
  }
  function wireSettingsOnce() {
    $("#save-settings").addEventListener("click", () => {
      state.settings.apiKey = $("#set-apikey").value.trim();
      state.settings.model = $("#set-model").value;
      state.settings.aiEnabled = $("#set-ai-enabled").checked;
      save();
      setStatus("#ai-status", "저장했어요.", "ok");
    });
    $("#test-ai").addEventListener("click", testAI);
    $("#edit-goals").addEventListener("click", () => {
      const g = prompt("목표를 수정하세요:", state.goals || "");
      if (g !== null) { state.goals = g.trim(); save(); renderProgress(); }
    });
    $("#export-data").addEventListener("click", exportData);
    $("#reset-data").addEventListener("click", () => {
      if (confirm("모든 기록이 삭제됩니다. 정말 초기화할까요?")) {
        localStorage.removeItem(LS_KEY); state = defaultState(); save(); renderAll(); switchTab("tab-today");
      }
    });
  }
  function setStatus(sel, msg, cls) { const el = $(sel); if (!el) return; el.textContent = msg; el.className = "notify-status " + (cls || ""); }
  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `coach-backup-${todayStr()}.json`; a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ============================ AI 피드백 ============================ */
  const SYSTEM_PROMPT = `당신은 글쓰기·말하기 전담 코치입니다. 언어학·교육심리학·수사학 이론에 근거해 피드백합니다.
반드시 지킬 규칙:
1) 형성평가 3요소로 답합니다 — ① 목표(Feed Up) ② 지금 어디에 있는지(Feed Back) ③ 다음에 무엇을 할지(Feed Forward).
2) 오늘의 목표 기술 한 가지에만 집중하고 다른 문제는 언급하지 않습니다(인지부하 관리).
3) 잘한 점 1가지를 '어느 문장이 왜 좋은지' 구체적으로 짚습니다. 칭찬은 노력·전략에 대해서만.
4) 개선점은 최대 2가지만.
5) 학습자의 문장 1~2개를 골라 '개선 전 → 개선 후'로 대비해 보여줍니다.
6) 단, 바로 고쳐주기 전에 "이 문장에서 뭐가 어색한지 찾아보세요"처럼 스스로 알아차리게 하는 질문을 먼저 던집니다(주목 가설).
7) 글을 통째로 대신 고쳐 쓰지 않습니다. 학습자가 고치게 만듭니다.
한국어로, 따뜻하지만 공허하지 않게, 400자 내외로 답하세요.`;

  function buildUserMessage(L, text, phase) {
    return `[오늘의 목표 기술] ${L.skill}
[목표] ${L.goal}
[과제] ${L.task}
[제약] ${(L.constraints || []).join(" / ")}
${phase === "retry" ? "[이것은 재도전 제출입니다. 개선 여부를 짚어주세요.]\n" : ""}
[학습자 제출]
${text}

위 제출에 대해 규칙에 따라 피드백해 주세요. 오늘 기술(${L.skill})에만 집중하세요.`;
  }

  async function callAnthropic(userMsg) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": state.settings.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: state.settings.model || "claude-sonnet-5",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMsg }]
      })
    });
    if (!res.ok) {
      let detail = ""; try { detail = (await res.json()).error?.message || ""; } catch (e) {}
      throw new Error(`${res.status} ${detail}`);
    }
    const data = await res.json();
    return (data.content || []).map(c => c.text || "").join("").trim();
  }

  async function requestAIFeedback(sess, L, text, phase) {
    const slot = phase === "retry" ? $("#ai-retry-slot") : $("#ai-fb");
    try {
      const out = await callAnthropic(buildUserMessage(L, text, phase));
      if (phase === "retry") sess.aiRetryFeedback = out; else sess.aiFeedback = out;
      save();
      if (slot) {
        if (phase === "retry") slot.innerHTML = `<div class="fb-block fb-improve"><span class="fb-h">🤖 재도전 피드백</span><div class="ai-answer">${esc(out)}</div></div>`;
        else slot.innerHTML = esc(out);
      }
    } catch (e) {
      if (slot) slot.innerHTML = `<span style="color:var(--danger)">AI 피드백 실패: ${esc(e.message)}. 설정에서 키/모델을 확인하세요. (아래 오프라인 피드백은 그대로 유효합니다.)</span>`;
    }
  }

  async function testAI() {
    const key = $("#set-apikey").value.trim();
    if (!key) { setStatus("#ai-status", "먼저 API 키를 입력하세요.", "err"); return; }
    state.settings.apiKey = key; state.settings.model = $("#set-model").value;
    setStatus("#ai-status", "연결 테스트 중…", "");
    try {
      const out = await callAnthropic("한 단어로 '연결됨'이라고만 답하세요.");
      setStatus("#ai-status", "연결 성공 ✓ — " + out.slice(0, 40), "ok");
    } catch (e) {
      setStatus("#ai-status", "연결 실패: " + e.message, "err");
    }
  }

  /* ============================ 유틸 ============================ */
  function extractCharLimit(constraints) {
    for (const c of (constraints || [])) {
      const m = String(c).match(/(\d+)\s*자\s*(이내|이하)/);
      if (m) return parseInt(m[1], 10);
    }
    return 0;
  }

  /* ============================ 탭 전환 ============================ */
  function switchTab(id) {
    $$(".tab").forEach(t => t.classList.toggle("active", t.id === id));
    $$(".nav-btn").forEach(b => b.classList.toggle("active", b.getAttribute("data-tab") === id));
    if (id === "tab-progress") renderProgress();
    if (id === "tab-log") renderLog();
    if (id === "tab-settings") renderSettings();
    window.scrollTo(0, 0);
  }

  /* ============================ 초기화 ============================ */
  function init() {
    $$(".nav-btn").forEach(b => b.addEventListener("click", () => switchTab(b.getAttribute("data-tab"))));
    wireSettingsOnce();
    renderAll();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }
  document.addEventListener("DOMContentLoaded", init);
})();
