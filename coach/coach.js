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

  /* 트랙 순환 패턴 (Day 2부터): 구조2 · 품질2 · 말하기2 · 복습1 = 7일 주기
     구조(문장·문단)와 품질(개연성·흥미·어휘)을 번갈아 배치해 서로를 보강한다. */
  /* 트랙 프리셋 — 목표에 따라 리듬을 바꾼다.
     말하기 중심에서는 글쓰기를 버리지 않고 '말할 내용을 만드는 도구'로 재배치한다. */
  const TRACK_PRESETS = {
    balanced: {
      label: "균형", desc: "글쓰기와 말하기를 고르게",
      pattern: ["write", "quality", "speak", "write", "quality", "speak", "review"]
    },
    speaking: {
      label: "말하기 중심", desc: "말하기 3 · 사회성 2 · 썰 1 · 복습 1",
      pattern: ["speak", "social", "speak", "story", "social", "speak", "review"]
    },
    story: {
      label: "썰·입담", desc: "재밌게 말하기 3 · 말하기 2 · 사회성 1 · 복습 1",
      pattern: ["story", "speak", "story", "social", "story", "speak", "review"]
    },
    social: {
      label: "사회성 집중", desc: "사회적 말하기와 대화 기술 위주",
      pattern: ["social", "speak", "social", "speak", "social", "story", "review"]
    },
    writing: {
      label: "글쓰기 중심", desc: "문장·구조·품질 위주",
      pattern: ["write", "quality", "write", "quality", "write", "quality", "review"]
    }
  };
  function currentPattern() {
    const p = TRACK_PRESETS[state.preset] || TRACK_PRESETS.balanced;
    return p.pattern;
  }
  const TRACK_PATTERN = TRACK_PRESETS.balanced.pattern;   // 하위 호환
  const TRACK_NAMES = { write: "구조", quality: "품질", speak: "말하기", social: "사회성", story: "썰", review: "복습·통합", diagnostic: "진단" };
  const TRACK_ICONS = { write: "✍️ 구조", quality: "✨ 품질", speak: "🎙️ 말하기", social: "🤝 사회성", story: "🎭 썰", review: "🔁 복습·통합" };
  /* 화면 필터링용 모드 — "글쓰기"만 순수 글쓰기, 나머지(말하기·썰·사회성)는 전부 말하기 계열.
     '균형'만 예외적으로 둘 다 섞는 프리셋이라 화면을 필터링하지 않고 전부 보여준다. */
  function currentMode() {
    if (state.preset === "balanced") return "both";
    if (state.preset === "writing") return "write";
    return "speak";
  }
  const MODE_TRACKS = { write: ["write", "quality"], speak: ["speak", "social", "story"], both: ["write", "quality", "speak", "social", "story"] };

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
      practices: [],          // 실전 말하기 연습 기록
      activePractice: null,   // 진행 중 실전 연습
      diagnosis: null,        // AI 진단 결과 { status, level, summary, strengths, weaknesses, advice }
      plan: {},               // 맞춤 커리큘럼 { day: skillId }
      planFrom: 0,            // 이 계획이 어느 Day부터 적용되는지
      focusWhy: {},           // { skillId: 목표와의 연결 이유 }
      recommendCats: [],      // 목표에 맞는 실전 말하기 카테고리
      planStale: false,       // 목표가 바뀌었는데 계획을 다시 짜지 않은 상태
      quality: [],            // 품질 6축 추이 [{date, day, scores, avg}]
      speech: [],             // 말하기·사회성 축 추이 [{date, track, scores}]
      roleplay: null,         // 진행 중 롤플레이 대화
      roleplayLog: [],        // 완료한 롤플레이 기록
      studyDone: [],          // 학습한 썰 해부 편
      anxiety: { level: null, log: [] },  // 발표불안 자기보고 추이
      preset: "balanced",     // 트랙 프리셋 (balanced|speaking|social|writing)
      drills: { done: [], correct: 0, total: 0 },  // A/B 안목 훈련 기록
      aiUsage: { date: "", count: 0 },  // 오늘 AI 호출 수 (절약 확인용)
      train: { daily: null, log: {}, xp: 0, correct: 0, total: 0 },  // 매일 훈련 진행
      settings: {
        aiEnabled: false,
        aiSaver: true,        // 절약 모드: AI 피드백을 탭할 때만 호출
        autoGenDrills: true,  // 안목 훈련 문제를 하루 1회 자동 생성
        provider: "gemini",   // 'gemini'(무료) | 'anthropic'(유료)
        gemini: { key: "", model: "gemini-2.5-flash" },
        anthropic: { key: "", model: "claude-sonnet-5" },
        notify: {
          enabled: false,
          morning: "09:00", evening: "20:30",   // 듀오링고식 하루 2회 — 아침 권유 + 저녁 스트릭 경고
          lastMorning: "", lastEvening: ""       // 'YYYY-MM-DD' — 오늘 이미 보냈는지
        }
      }
    };
  }
  let state = load();
  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return defaultState();
      const s = Object.assign(defaultState(), JSON.parse(raw));
      normalizeSettings(s);
      return s;
    } catch (e) { return defaultState(); }
  }
  /* 예전(단일 Anthropic) 설정을 새 제공자별 구조로 이관 */
  function normalizeSettings(s) {
    const set = s.settings = s.settings || {};
    if (typeof set.aiEnabled !== "boolean") set.aiEnabled = false;
    if (typeof set.aiSaver !== "boolean") set.aiSaver = true;
    if (typeof set.autoGenDrills !== "boolean") set.autoGenDrills = true;
    if (typeof set.dailyBudget !== "number" || set.dailyBudget <= 0) set.dailyBudget = 40;
    if (!set.notify) set.notify = {};
    if (typeof set.notify.enabled !== "boolean") set.notify.enabled = false;
    if (!set.notify.morning) set.notify.morning = "09:00";
    if (!set.notify.evening) set.notify.evening = "20:30";
    if (typeof set.notify.lastMorning !== "string") set.notify.lastMorning = "";
    if (typeof set.notify.lastEvening !== "string") set.notify.lastEvening = "";
    if (!s.plan) s.plan = {};
    if (!s.focusWhy) s.focusWhy = {};
    if (!s.recommendCats) s.recommendCats = [];
    if (typeof s.planFrom !== "number") s.planFrom = 0;
    if (typeof s.planStale !== "boolean") s.planStale = false;
    if (!s.quality) s.quality = [];
    if (!s.speech) s.speech = [];
    if (!s.roleplayLog) s.roleplayLog = [];
    if (!s.studyDone) s.studyDone = [];
    if (!s.anxiety) s.anxiety = { level: null, log: [] };
    if (!s.preset || !TRACK_PRESETS[s.preset]) s.preset = "balanced";
    if (!s.drills) s.drills = { done: [], correct: 0, total: 0 };
    if (!s.aiUsage) s.aiUsage = { date: "", count: 0 };
    if (!s.train) s.train = { daily: null, log: {}, xp: 0, correct: 0, total: 0 };
    if (!s.train.log) s.train.log = {};
    if (typeof s.train.xp !== "number") s.train.xp = 0;
    if (typeof s.train.correct !== "number") s.train.correct = 0;
    if (typeof s.train.total !== "number") s.train.total = 0;
    if (!set.provider) set.provider = "gemini";
    if (!set.gemini) set.gemini = { key: "", model: "gemini-2.5-flash" };
    if (!set.anthropic) set.anthropic = { key: set.apiKey || "", model: set.model || "claude-sonnet-5" };
    delete set.apiKey; delete set.model;
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
    const n = lens.length;
    const mean = n ? lens.reduce((a, b) => a + b, 0) / n : 0;
    const sd = n ? Math.sqrt(lens.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n) : 0;
    return {
      chars: charLen(t),
      sentences: n,
      lens,
      mean: Math.round(mean),
      sd: Math.round(sd),
      longest: n ? Math.max(...lens) : 0,
      shortest: n ? Math.min(...lens) : 0,
      fillers: countMatches(t, /것(이|을|은|도|과|처럼|만|입니|이다|같)?|수\s*있|에\s*대(해|하여|한)|라고\s*생각|생각(된|되는|됩|이\s*든)|느껴(진|집)|부분(이|을|은)?\s*있|측면|경우가\s*많|하게\s*되|지게\s*되|매우|정말|너무|굉장히|상당히|좀|약간|다소/g),
      passives: countMatches(t, /되었|되어|되는|어졌|아졌|여졌|당하|지어/g),
      connectors: countMatches(t, /그리고|그래서|하지만|그러나|또한|그런데|따라서|그러므로/g),
      emotionWords: countMatches(t, /행복|슬프|슬픔|기쁘|기쁨|감동|좋았|힘들|즐거|재미있|아름답|설레/g),
      // ↓ 확장 지표 (API 없이 쓸모 있는 분석을 위해)
      hedges: countMatches(t, /같아요|같다|듯하|아마|어느\s*정도|조금|약간|나름|그럭저럭|일단/g),
      senses: countMatches(t, /보이|보였|들리|들렸|소리|냄새|향|맛|차갑|따뜻|뜨겁|시원|축축|거칠|부드럽|빛|어둡|환하/g),
      numbers: countMatches(t, /\d+(\.\d+)?\s*(%|퍼센트|명|개|번|원|배|건|일|주|달|년|시간|분)/g),
      conjTails: countMatches(t, /(고|며|서|는데|지만|나까|므로)\s*,?\s*(?=[가-힣])/g),
      sameEnding: maxSameEndingRun(sents),
      longRatio: n ? Math.round(lens.filter(l => l > 60).length / n * 100) : 0,
      firstLen: n ? lens[0] : 0,
      questions: countMatches(t, /\?/g),
      quotes: countMatches(t, /["“'']/g)
    };
  }
  /* 문장 종결어미가 연속으로 같은 최대 횟수 (리듬 단조로움 탐지) */
  function maxSameEndingRun(sents) {
    const endOf = (s) => {
      const m = String(s).trim().match(/(습니다|입니다|했다|한다|이다|있다|었다|아요|어요|예요|네요|겠다|자|요)$/);
      return m ? m[1] : "";
    };
    let best = 1, run = 1;
    for (let i = 1; i < sents.length; i++) {
      const a = endOf(sents[i - 1]), b = endOf(sents[i]);
      if (a && a === b) { run++; best = Math.max(best, run); } else run = 1;
    }
    return sents.length ? best : 0;
  }
  /* ---- 로컬 품질 스캔 — 사전 기반. API 없이 품질 힌트를 주고,
         AI 호출 시에는 프롬프트에 넣어 1회 호출의 정확도를 올린다. ---- */
  function findAll(text, list) {
    const hits = [];
    (list || []).forEach(w => { if (text.indexOf(w) >= 0) hits.push(w); });
    return hits;
  }
  function localQualityScan(text) {
    const t = String(text || "");
    const m = metrics(t);
    const formal = findAll(t, LEXICON.formalMarkers);
    const casual = findAll(t, LEXICON.casualMarkers);
    return {
      cliches: findAll(t, LEXICON.cliches),
      vagueNouns: findAll(t, LEXICON.vagueNouns),
      intensifiers: findAll(t, LEXICON.intensifiers),
      hedges: findAll(t, LEXICON.hedges),
      emptyPatterns: findAll(t, LEXICON.emptyPatterns),
      registerMix: formal.length > 0 && casual.length > 0,
      formal, casual,
      senses: m.senses, numbers: m.numbers, emotionWords: m.emotionWords,
      sameEnding: m.sameEnding
    };
  }
  /* 스캔 결과를 사람이 읽는 한 덩어리로 (오프라인 품질 힌트) */
  function qualityScanHTML(scan) {
    const rows = [];
    const line = (emoji, label, arr, advice) => {
      if (!arr.length) return;
      rows.push(`<div class="scan-row"><span class="scan-k">${emoji} ${label}</span>
        <span class="scan-v">${arr.slice(0, 5).map(w => `<code>${esc(w)}</code>`).join(" ")}${arr.length > 5 ? ` +${arr.length - 5}` : ""}</span>
        <span class="scan-a">${esc(advice)}</span></div>`);
    };
    line("🗿", "클리셰", scan.cliches, "닳은 표현입니다. 실제 관찰로 바꾸세요.");
    line("🌫️", "막연한 명사", scan.vagueNouns, "‘구체적으로 무엇?’에 답해 교체하세요.");
    line("📢", "강조 부사", scan.intensifiers, "지우고 동사·명사를 더 정확하게 바꾸세요.");
    line("🌀", "완충 표현", scan.hedges, "판단이 흐려집니다. 단언할 수 있는지 보세요.");
    line("🫙", "빈 문형", scan.emptyPatterns, "정보가 없는 문장입니다. 구체적 판단으로.");
    if (scan.registerMix) {
      rows.push(`<div class="scan-row"><span class="scan-k">🎭 문체 혼용</span>
        <span class="scan-v">${scan.formal.slice(0,2).map(w=>`<code>${esc(w)}</code>`).join(" ")} ↔ ${scan.casual.slice(0,2).map(w=>`<code>${esc(w)}</code>`).join(" ")}</span>
        <span class="scan-a">격식체와 구어체가 섞였습니다. 하나로 통일하세요.</span></div>`);
    }
    if (scan.emotionWords >= 2 && scan.senses <= 1) {
      rows.push(`<div class="scan-row"><span class="scan-k">🎨 감각 부족</span>
        <span class="scan-v">감정어 ${scan.emotionWords} vs 감각어 ${scan.senses}</span>
        <span class="scan-a">감정 단어를 그 순간의 감각으로 바꾸세요.</span></div>`);
    }
    if (scan.sameEnding >= 3) {
      rows.push(`<div class="scan-row"><span class="scan-k">🔁 종결어미 반복</span>
        <span class="scan-v">${scan.sameEnding}문장 연속</span>
        <span class="scan-a">낭독 시 단조로워집니다. 하나를 다른 형태로.</span></div>`);
    }
    if (!rows.length) return `<p class="muted small">표면 지표에서는 걸리는 표현이 없습니다. 아래 독자 리포트로 내용을 점검해보세요.</p>`;
    return `<div class="scan-table">${rows.join("")}</div>`;
  }

  /* ---- 로컬 말하기 분석 (API 0원) ----
   * 글과 말은 기준이 다르다. 말은 되돌려 들을 수 없어 문장이 더 짧아야 하고,
   * 채움말·신호어·결론 위치가 이해도를 좌우한다. 이 지표를 프롬프트에도 넣어
   * 1회 호출의 정확도를 올린다. */
  function countList(text, list) {
    let n = 0, hits = [];
    (list || []).forEach(w => {
      const c = (String(text).split(w).length - 1);
      if (c > 0) { n += c; hits.push(w + (c > 1 ? "×" + c : "")); }
    });
    return { n, hits };
  }
  function localSpeechScan(transcript) {
    const t = String(transcript || "");
    const sents = splitSentences(t);
    const lens = sents.map(charLen);
    const n = lens.length;
    const mean = n ? Math.round(lens.reduce((a, b) => a + b, 0) / n) : 0;
    const fillers = countList(t, SPEECH_LEXICON.fillers);
    const signposts = countList(t, SPEECH_LEXICON.signposts);
    const hedges = countList(t, SPEECH_LEXICON.hedges);
    const listening = countList(t, SPEECH_LEXICON.listeningMarkers);
    const questions = countList(t, SPEECH_LEXICON.questionMarkers);
    // 결론 위치 — 결론 표지가 앞 1/3에 있으면 두괄식
    const concIdx = SPEECH_LEXICON.conclusionMarkers
      .map(w => t.indexOf(w)).filter(i => i >= 0).sort((a, b) => a - b)[0];
    let conclusion = "불명";
    if (typeof concIdx === "number" && t.length) {
      const r = concIdx / t.length;
      conclusion = r < 0.34 ? "앞(두괄식)" : r < 0.67 ? "중간" : "뒤(미괄식)";
    }
    return {
      chars: charLen(t), sentences: n, meanLen: mean,
      longSentences: lens.filter(l => l > 40).length,
      fillers: fillers.n, fillerHits: fillers.hits,
      signposts: signposts.n, signpostHits: signposts.hits,
      hedges: hedges.n, hedgeHits: hedges.hits,
      listening: listening.n, questions: questions.n,
      questionMarks: countMatches(t, /\?/g),
      conclusion: conclusion,
      fillerPerSentence: n ? +(fillers.n / n).toFixed(1) : 0
    };
  }
  /* 스캔 결과를 사람이 읽는 카드로 (오프라인에서도 유용한 피드백) */
  function speechScanHTML(sc) {
    const row = (emoji, label, value, verdict, good) =>
      `<div class="scan-row"><span class="scan-k">${emoji} ${label}</span>
        <span class="scan-v"><b class="${good ? "sv-ok" : "sv-warn"}">${esc(value)}</b></span>
        <span class="scan-a">${esc(verdict)}</span></div>`;
    const rows = [];
    rows.push(row("🗣️", "채움말", `${sc.fillers}회 (문장당 ${sc.fillerPerSentence})`,
      sc.fillerPerSentence <= 0.5 ? "자연스러운 수준이에요." : "문장 경계마다 나오면 준비 부족으로 들려요. 침묵으로 대체하세요.",
      sc.fillerPerSentence <= 0.5));
    rows.push(row("🧭", "신호어", `${sc.signposts}회`,
      sc.signposts >= 2 ? "청자가 길을 찾을 수 있어요." : "'첫째/정리하면'을 넣으면 이해도가 올라갑니다.",
      sc.signposts >= 2));
    rows.push(row("✂️", "문장 길이", `평균 ${sc.meanLen}자 (40자 초과 ${sc.longSentences}개)`,
      sc.meanLen <= 30 ? "말하기에 적절한 길이예요." : "말은 글보다 짧아야 해요. 접속어미에서 끊으세요.",
      sc.meanLen <= 30));
    rows.push(row("🎯", "결론 위치", sc.conclusion,
      sc.conclusion === "앞(두괄식)" ? "결론이 먼저 도착합니다." : "결론을 첫 문장으로 올리면 30초 안에 요점이 전달돼요.",
      sc.conclusion === "앞(두괄식)"));
    if (sc.hedges > 2) rows.push(row("🌀", "완충어", `${sc.hedges}회`,
      "'~같아요'가 많으면 주장이 흐려집니다. 아는 건 단언하세요.", false));
    return `<div class="scan-table">${rows.join("")}</div>`;
  }

  /* 규칙 기반 진단 — API 없이 약점 후보를 커리큘럼 기술로 매핑 */
  function localDiagnose(text) {
    const m = metrics(text);
    const findings = [];
    const add = (skillId, why) => { if (!findings.find(f => f.skillId === skillId)) findings.push({ skillId, why }); };
    const per = m.sentences ? m.fillers / m.sentences : 0;
    if (m.fillers >= 3 || per >= 0.8) add("concision", `군더더기 후보 표현이 ${m.fillers}회(문장당 ${per.toFixed(1)}회) 나타납니다 — ‘것/수 있다/생각된다/부분이 있다’ 같은 표현이 서술어를 감쌉니다.`);
    if (m.hedges >= 3) add("concision", `‘~같아요/아마/조금’ 같은 완충 표현이 ${m.hedges}회 — 문장이 흐려집니다.`);
    if (m.passives >= 2) add("active-voice", `피동 표현이 ${m.passives}회 — 행위자가 숨습니다.`);
    if (m.sd <= 10 && m.sentences >= 3) add("sentence-rhythm", `문장 길이 편차가 작습니다(표준편차 ${m.sd}자) — 리듬이 단조롭습니다.`);
    if (m.sameEnding >= 3) add("sentence-rhythm", `같은 종결어미가 ${m.sameEnding}문장 연속됩니다.`);
    if (m.conjTails >= Math.max(3, Math.round(m.sentences * 1.2))) add("connectors", `‘~고/~며/~서’로 이어 붙인 연결이 ${m.conjTails}회 — 문장을 끊어야 합니다.`);
    if (m.connectors >= 3) add("connectors", `접속사를 ${m.connectors}회 사용 — 내용으로 잇는 연습이 필요합니다.`);
    if (m.emotionWords >= 2 && m.senses <= 1) add("concreteness", `감정·평가 단어 ${m.emotionWords}회에 비해 감각 묘사는 ${m.senses}회 — 추상적입니다.`);
    if (m.senses === 0 && m.chars >= 150) add("concreteness", "보이고 들리는 감각 묘사가 없어 장면이 그려지지 않습니다.");
    if (m.longRatio >= 40) add("sentence-rhythm", `60자 넘는 긴 문장이 전체의 ${m.longRatio}%입니다.`);
    if (m.numbers === 0 && m.chars >= 200) add("argument", "구체적 수치·사례가 없어 주장이 떠 있습니다.");
    if (m.firstLen >= 60) add("topic-first", `첫 문장이 ${m.firstLen}자로 길어, 핵심이 앞에서 또렷하지 않습니다.`);
    if (!findings.length) add("topic-first", "표면 지표는 양호합니다. 다음은 문단 구성(두괄식)으로 올라가 봅시다.");
    return { metrics: m, findings: findings.slice(0, 4) };
  }

  /* -------------------- 오프라인(자기 주목형) 피드백 -------------------- */
  /* AI 없이도 '구체적 관찰 + 스스로 발견 질문'을 제공한다(주목 가설).       */
  function localObservation(lesson, text) {
    const m = metrics(text);
    const base = `분량 <b>${m.chars}자</b> · 문장 <b>${m.sentences}개</b> · 평균 ${m.mean}자(편차 ${m.sd})`;
    let obs = [];
    switch (lesson.id) {
      case "concision":
        obs.push(`군더더기 후보 <b>${m.fillers}회</b>, 완충 표현('~같아요/아마') <b>${m.hedges}회</b>.`);
        obs.push(m.fillers + m.hedges > 3 ? "빼도 뜻이 사는 표현이 남아 있을 가능성이 높아요. 단어마다 '없으면 뜻이 달라지나?' 물어보세요." : "잘 걷어냈어요. 수식어를 한 번 더 줄일 수 있는지 보세요.");
        break;
      case "active-voice":
        obs.push(`피동 표현 <b>${m.passives}회</b>.`);
        obs.push(m.passives > 1 ? "피동 문장마다 '누가 한 일인지' 물어 주어를 되살리세요." : "행위자가 대체로 잘 드러나 있어요.");
        break;
      case "sentence-rhythm":
        obs.push(`문장 길이: <b>${m.lens.join(", ") || "-"}</b>자. 같은 종결어미 연속 최대 <b>${m.sameEnding}회</b>.`);
        obs.push(m.sd <= 10 ? "편차가 작아 리듬이 단조로워요. 핵심 문장 하나를 아주 짧게 쳐 보세요." : "길이 변주가 살아 있어요. 가장 중요한 문장이 가장 짧은지 확인하세요.");
        if (m.sameEnding >= 3) obs.push("종결어미가 반복되면 낭독할 때 지루해집니다.");
        break;
      case "connectors":
        obs.push(`접속사 <b>${m.connectors}회</b>, '~고/~며/~서' 연결 <b>${m.conjTails}회</b>.`);
        obs.push(m.connectors > 0 ? "접속사를 지워도 흐름이 유지되는지 시험해 보세요." : "접속사 없이 이었네요. 앞 문장의 말을 뒤 문장이 이어받았는지 보세요.");
        break;
      case "concreteness":
        obs.push(`감정·평가 단어 <b>${m.emotionWords}회</b> vs 감각 묘사 <b>${m.senses}회</b>.`);
        obs.push(m.senses === 0 ? "감각어가 없어 장면이 그려지지 않아요. 그 순간 본 사물 하나를 넣으세요." : m.emotionWords > m.senses ? "감정어가 감각어보다 많아요. 감정 단어를 장면으로 바꿔보세요." : "감각으로 보여주기가 잘 됐어요.");
        break;
      case "argument":
        obs.push(`구체적 수치·사례 표현 <b>${m.numbers}회</b>.`);
        obs.push(m.numbers === 0 ? "예시가 일반론에 머물 위험이 있어요. '언제·어디서·누가'를 넣어 장면으로 만드세요." : "근거가 구체적으로 뒷받침되고 있어요.");
        break;
      case "topic-first":
        obs.push(`첫 문장 <b>${m.firstLen}자</b>(평균 ${m.mean}자).`);
        obs.push(m.firstLen > m.mean * 1.4 ? "첫 문장이 평균보다 길어요. 핵심 주장을 짧고 단호하게 압축하세요." : "첫 문장 길이는 적절해요. 그 문장만 읽어도 문단이 예측되나요?");
        break;
      case "one-idea": case "structure": case "audience":
        obs.push(`문단 구성: 문장 ${m.sentences}개, 질문형 ${m.questions}회.`);
        obs.push("첫 문장만 따로 읽어보세요 — 전체가 예측되나요? 화제가 바뀌는 지점이 문단 경계입니다.");
        break;
      default:
        obs.push("아래 질문으로 스스로 점검해 보세요.");
    }
    return base + "<br>" + obs.join(" ");
  }

  /* ----------------------------- 스케줄러 ----------------------------- */
  /* 구조 트랙(문장·문단·글 전체)과 품질 트랙(개연성·흥미·어휘…)을 함께 굴린다 */
  const ALL_LESSONS = CURRICULUM.concat(QUALITY_LESSONS, SPEECH_LESSONS, SOCIAL_LESSONS, STORY_LESSONS);
  const WRITE_POOL = CURRICULUM.filter(l => l.track === "write");
  /* 말하기 풀 = 기존 curriculum의 speak 레슨 + 새 스피치 레슨(리허설 구조) */
  const SPEAK_POOL = CURRICULUM.filter(l => l.track === "speak").concat(SPEECH_LESSONS);
  const QUALITY_POOL = QUALITY_LESSONS;
  const SOCIAL_POOL = SOCIAL_LESSONS;
  const STORY_POOL = STORY_LESSONS;
  const POOLS = { write: WRITE_POOL, speak: SPEAK_POOL, quality: QUALITY_POOL,
                  social: SOCIAL_POOL, story: STORY_POOL };
  const byId = (id) => ALL_LESSONS.find(l => l.id === id);
  /* 축 조회 — 품질/말하기/사회성 축을 모두 커버 */
  const ALL_DIMS = QUALITY_DIMS.concat(SPEECH_DIMS, SOCIAL_DIMS, STORY_DIMS);
  const dimOf = (key) => ALL_DIMS.find(d => d.key === key);

  function trackForDay(day) {
    if (day <= 1) return "diagnostic";
    const pat = currentPattern();
    return pat[(day - 2) % pat.length];
  }

  function weakestSkill(track) {
    // rating===1(더 필요) 인 기술 중 가장 오래전에 다룬 것 (간격 반복 인출)
    const pool = POOLS[track] || WRITE_POOL;
    const weak = pool
      .filter(l => state.skills[l.id] && state.skills[l.id].rating === 1)
      .sort((a, b) => (state.skills[a.id].lastDay || 0) - (state.skills[b.id].lastDay || 0));
    return weak[0] || null;
  }

  function pickLesson(day, track) {
    const pool = POOLS[track] || WRITE_POOL;
    // 품질 트랙은 독자 리포트에서 가장 낮은 축을 우선 겨냥한다(의도적 연습)
    if (track === "quality") {
      const weakDim = weakestQualityDim();
      if (weakDim) {
        const cands = pool.filter(l => l.dim === weakDim)
          .sort((a, b) => ((state.skills[a.id] || {}).lastDay || 0) - ((state.skills[b.id] || {}).lastDay || 0));
        if (cands.length) return cands[0];
      }
    }
    /* 노출 위계 — 불안이 높다고 보고한 학습자는 쉬운 말하기 과제부터.
       회피를 막으려면 난이도를 단계적으로 올려야 한다(행동치료의 표준). */
    if (track === "speak") {
      const log = (state.anxiety && state.anxiety.log) || [];
      const recent = log.slice(-3);
      const avgAnx = recent.length ? recent.reduce((a, b) => a + b.level, 0) / recent.length : 0;
      if (avgAnx >= 4) {
        // 긴장도가 높으면 준비 시간이 길고 발화가 짧은 과제부터
        const easy = pool.filter(l => l.speak && (l.speak.speakSec || 0) <= 60)
          .sort((a, b) => ((state.skills[a.id] || {}).lastDay || 0) - ((state.skills[b.id] || {}).lastDay || 0));
        if (easy.length) return easy[0];
      }
    }
    // 진단으로 만든 맞춤 커리큘럼이 있으면 그 순서를 우선한다
    const planned = state.plan && state.plan[String(day)];
    if (planned) {
      const l = pool.find(x => x.id === planned);
      if (l) return l;
    }
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

  /* ==================== 독자 리포트 · 품질 6축 ====================
   * AI를 '채점관'이 아니라 '독자'로 쓴다. 점수보다 중요한 것은
   * "여기서 지루해졌다 / 여기서 왜?라는 의문이 생겼다"는 반응이다.
   * 제출당 1회 호출로 6축 점수 + 독자 반응 + 최우선 수정을 한꺼번에 받는다.
   * ============================================================== */
  const QUALITY_SYSTEM = `당신은 글의 '수준'을 평가하는 독자이자 글쓰기 코치입니다. 구조적 결함(오탈자·문법)이 아니라
글의 질(개연성·흥미·어휘·밀도·목소리·독자 배려)을 판단합니다.

## 가장 중요한 원칙
당신은 채점관이 아니라 **한 명의 독자**입니다. "3점입니다"는 학습자를 못 고치게 합니다.
"여기서 지루해졌어요", "여기서 '왜?'라는 의문이 생겼는데 답이 안 나왔어요",
"이 문장은 누가 무엇에 대해 써도 되는 말이에요" — 이렇게 **읽는 동안 실제로 일어난 일**을 말하세요.

## 6개 축 (1~5점)
- coherence(개연성): 앞 문장이 뒤 문장을 벌어들이는가. 논리 비약이 없는가. 독자의 질문에 제때 답하는가.
- interest(흥미): 계속 읽고 싶은가. 긴장·의외성·이해관계·구체적 장면이 있는가.
- diction(어휘): 그 자리에 그 단어가 맞는가. 막연한 말·클리셰·문체 혼용이 없는가.
- density(밀도): 매 문장이 새 정보를 주는가. 반복·빈 문장이 없는가. 뻔하지 않은가.
- voice(목소리): 쓴 사람이 보이는가. 태도가 일관된가.
- reader(독자 배려): 독자가 아는 것/모르는 것을 구분했는가.
점수 기준: 1=심각한 문제, 2=약함, 3=보통(무난하지만 인상 없음), 4=좋음, 5=뛰어남.
후하게 주지 마세요. 대부분의 초고는 2~3점입니다. 5점은 정말 뛰어날 때만.

## 반드시 아래 JSON만 출력 (코드블록·설명·인사말 금지)
{
  "scores": {"coherence":3,"interest":2,"diction":3,"density":2,"voice":3,"reader":4},
  "oneLine": "독자로서 이 글을 읽은 소감 한 문장. 솔직하게.",
  "readerReport": [
    {"type":"good|bored|confused|curious|generic|gap","quote":"학습자 글의 실제 인용","note":"읽는 동안 무슨 일이 일어났는지 한두 문장"}
  ],
  "topFix": {"dim":"6축 중 하나의 key","quote":"가장 먼저 고쳐야 할 학습자의 문장","why":"왜 이것이 최우선인지","rewrite":"고친 예시 한 문장"},
  "nextFocus": {"dim":"다음에 훈련할 축 key","task":"이 학습자에게 지금 필요한 구체적 연습 한 가지"}
}
readerReport는 3~5개. type의 뜻 —
good(여기서 좋았다) / bored(지루해졌다) / confused(못 따라갔다) /
curious(궁금해졌다) / generic(누구나 쓸 수 있는 말이다) / gap(전제가 빠져 막혔다).
반드시 최소 1개는 good을 포함하고, 인용은 학습자 글의 실제 표현이어야 합니다.

## JSON 형식 주의 (반드시)
- 값 안에 큰따옴표(")를 쓰지 마세요. 인용이 필요하면 홑따옴표(')나 그냥 따옴표 없이 쓰세요.
- 값 안에서 줄바꿈하지 마세요.
- 마지막 항목 뒤에 콤마를 붙이지 마세요.`;

  function qualityUserMessage(text, ctx) {
    const m = metrics(text), scan = localQualityScan(text);
    const flag = (label, arr) => arr.length ? `${label}: ${arr.join(", ")}` : "";
    const flags = [
      flag("클리셰", scan.cliches), flag("막연한 명사", scan.vagueNouns),
      flag("강조 부사", scan.intensifiers), flag("완충 표현", scan.hedges),
      flag("빈 문형", scan.emptyPatterns),
      scan.registerMix ? `문체 혼용: ${scan.formal.join(",")} ↔ ${scan.casual.join(",")}` : ""
    ].filter(Boolean).join(" / ") || "특별히 걸리는 표현 없음";
    return `[글의 맥락] ${ctx || "자유 글쓰기"}
[학습자 목표] ${state.goals || "(밝히지 않음)"}

[기계 분석 참고치 — 그대로 나열하지 말고 판단 근거로만]
문장 ${m.sentences}개 / 평균 ${m.mean}자(편차 ${m.sd}) / 감각어 ${m.senses} / 수치 ${m.numbers} / 동일종결어미연속 ${m.sameEnding}
사전 탐지: ${flags}

[학습자의 글]
${text}

이 글을 독자로서 읽고, 6축 점수와 독자 리포트를 JSON으로 출력하세요.`;
  }

  function weakestQualityDim() {
    // 최근 3회 리포트의 평균이 가장 낮은 축
    const recent = (state.quality || []).slice(-3);
    if (!recent.length) return null;
    let best = null, bestVal = 99;
    QUALITY_DIMS.forEach(d => {
      const vals = recent.map(r => r.scores && r.scores[d.key]).filter(v => typeof v === "number");
      if (!vals.length) return;
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      if (avg < bestVal) { bestVal = avg; best = d.key; }
    });
    return bestVal <= 3.5 ? best : null;
  }

  function qualityAvg(scores) {
    const vals = QUALITY_DIMS.map(d => scores[d.key]).filter(v => typeof v === "number");
    return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  }

  const RR_STYLE = {
    good:     ["rr-good", "👍", "좋았던 지점"],
    bored:    ["rr-bored", "😐", "지루해진 지점"],
    confused: ["rr-confused", "❓", "못 따라간 지점"],
    curious:  ["rr-curious", "🤔", "궁금해진 지점"],
    generic:  ["rr-generic", "🫥", "누구나 쓸 수 있는 말"],
    gap:      ["rr-gap", "🕳️", "전제가 빠진 지점"]
  };

  function renderQualityReport(rep, opts) {
    if (!rep || !rep.scores) return "";
    const o = opts || {};
    const bars = QUALITY_DIMS.map(d => {
      const v = rep.scores[d.key] || 0;
      const pct = Math.max(0, Math.min(100, v / 5 * 100));
      const cls = v <= 2 ? "low" : v === 3 ? "mid" : "high";
      return `<div class="qbar-row" title="${esc(d.detail)}">
        <span class="qbar-label">${d.emoji} ${esc(d.label)}</span>
        <span class="qbar-track"><span class="qbar-fill ${cls}" style="width:${pct}%"></span></span>
        <span class="qbar-val ${cls}">${v}</span>
      </div>`;
    }).join("");
    const items = (rep.readerReport || []).map(r => {
      const st = RR_STYLE[r.type] || RR_STYLE.good;
      return `<div class="rr-item ${st[0]}">
        <div class="rr-head">${st[1]} ${st[2]}</div>
        ${r.quote ? `<div class="quote-line">“${esc(r.quote)}”</div>` : ""}
        <div class="rr-note">${esc(r.note || "")}</div>
      </div>`;
    }).join("");
    const tf = rep.topFix;
    const nf = rep.nextFocus;
    const avg = qualityAvg(rep.scores);
    return `
      ${rep.oneLine ? `<div class="fb-block fb-now"><span class="fb-h">🗣️ 독자의 한마디</span>${esc(rep.oneLine)}</div>` : ""}
      <div class="qscore-card">
        <div class="qscore-head">
          <span class="qscore-title">품질 6축</span>
          <span class="qscore-avg">평균 <b>${avg.toFixed(1)}</b> / 5</span>
        </div>
        ${bars}
      </div>
      ${items ? `<div class="section-label">읽는 동안 무슨 일이 있었나</div>${items}` : ""}
      ${tf ? `<div class="fb-block fb-surgery">
        <span class="fb-h">✂️ 가장 먼저 고칠 것 ${tf.dim && dimOf(tf.dim) ? `· ${esc(dimOf(tf.dim).label)}` : ""}</span>
        ${tf.quote ? `<div class="sg before"><span class="sg-tag">전</span>${esc(tf.quote)}</div>` : ""}
        ${tf.rewrite ? `<div class="sg after"><span class="sg-tag">후</span>${esc(tf.rewrite)}</div>` : ""}
        ${tf.why ? `<div class="sg why">→ ${esc(tf.why)}</div>` : ""}
      </div>` : ""}
      ${nf ? `<div class="fb-block fb-next">
        <span class="fb-h">➡️ 다음에 훈련할 것 ${nf.dim && dimOf(nf.dim) ? `· ${esc(dimOf(nf.dim).label)}` : ""}</span>
        ${esc(nf.task || "")}
      </div>` : ""}
      ${o.compare ? o.compare : ""}`;
  }

  async function requestQualityReport(slotId, text, ctx, onDone) {
    const slot = $("#" + slotId);
    if (slot) slot.innerHTML = `<span class="spinner"></span>독자가 당신의 글을 읽고 있어요…`;
    try {
      const raw = await callAI(QUALITY_SYSTEM, qualityUserMessage(text, ctx), 3200, true);
      const j = extractJSON(raw);
      if (!j.scores) throw new Error("점수가 없습니다");
      if (onDone) onDone(j);
      const s2 = $("#" + slotId);
      if (s2) s2.innerHTML = renderQualityReport(j);
      return j;
    } catch (e) {
      const s2 = $("#" + slotId);
      if (s2) s2.innerHTML = `<span style="color:var(--danger)">독자 리포트 실패: ${esc(e.message)}</span>
        <button class="btn ghost small" id="${slotId}-retry">다시 시도</button>`;
      const rb = $("#" + slotId + "-retry");
      if (rb) rb.addEventListener("click", () => requestQualityReport(slotId, text, ctx, onDone));
      return null;
    }
  }

  /* 세션에서 받은 리포트를 추이 기록에 남긴다 */
  function recordQuality(rep, meta) {
    if (!rep || !rep.scores) return;
    state.quality = state.quality || [];
    state.quality.push({
      date: todayStr(), day: meta && meta.day, lessonId: meta && meta.lessonId,
      pass: meta && meta.pass, scores: rep.scores, avg: qualityAvg(rep.scores),
      oneLine: rep.oneLine || ""
    });
    save();
  }

  /* ==================== 스피치 코치 (말하기·사회성) ====================
   * docs/speech-coach-prompt.md 설계 반영.
   * 이론에 번호를 붙여 인용을 강제하고, 판단 절차를 명시해 Flash급 모델의
   * 일관성을 끌어올린다. 오개념(메라비언 7-38-55 등)은 명시적으로 차단. */
  const SPEECH_THEORY = `## 이론 기반 (판단 근거 — 지적할 때 원리 이름을 밝힐 것)
[전달·구조]
1 인지부하(Sweller): 듣기는 되돌릴 수 없다. 말의 문장은 글보다 짧아야 한다.
2 Given-New: 아는 정보에서 새 정보로. 새 정보를 문두에 쏟으면 청자가 놓친다.
3 결론 선행(PREP/BLUF): 주의는 처음 30초가 최대다. 결론을 먼저, 이유·예시는 뒤에.
4 담화 표지: '첫째/정리하면/중요한 건'이 청자의 길찾기를 돕는다.
5 채움말: 소량은 자연스럽다. 문장 경계마다면 준비 부족 신호. 목표는 0이 아니라 '침묵으로 대체'.
[불안·심리]
6 발표불안은 성인 다수의 정상 반응. 인지 요소(파국적 예상)와 신체 요소를 구분해 다룬다.
7 재평가: '진정하자'보다 '이 각성은 흥분이다'가 수행을 올린다.
8 노출 위계: 불안은 회피로 강화된다. 쉬운 상황부터 단계적으로.
9 자기초점 주의: 불안한 화자는 주의가 자기 몸으로 향한다. 주의를 청자로 돌리게 하라.
10 성장 마인드셋: 피드백은 능력이 아니라 '전략'에 귀속시켜라.
[사회적 상호작용]
11 협력 원리(Grice): 필요한 만큼(양)·참되게(질)·관련되게(관련)·명료하게(방식).
12 공손 이론(Brown & Levinson): 요청·거절·반대는 체면 위협. 완충과 직설의 균형이 기술이다.
13 순서교대(Sacks/Schegloff): 끼어들기·침묵 견디기·순서 넘겨주기는 학습 가능한 기술.
14 적극적 경청: 재진술·감정 반영·후속 질문이 신뢰를 만든다. 사회성은 '받기'에서 갈린다.
15 후속 질문과 호감: 질문을 많이 하는 사람이 더 호감을 산다. 자기 말만 하면 깎인다.
16 자기개방(사회침투): 점진적·상호적 개방이 친밀감을 만든다. 이르거나 일방적이면 역효과.
17 스포트라이트 효과: 타인은 내 실수를 내가 생각하는 것보다 훨씬 덜 본다.
18 산출·인출 연습: 소리 내어 반복한 발화가 묵독 준비보다 수행을 올린다.
19 피드백(Hattie & Timperley): 목표-현재-다음 세 질문에 답해야 학습이 된다.
20 ZPD(Vygotsky): 지금보다 반 걸음 위를 겨냥하라.

## 오개념 금지
- '의사소통의 93%는 비언어'(메라비언 7-38-55)는 특수 실험의 오용이다. 인용 금지.
- '청중을 감자로 봐라', '떨지 마라' 류의 통념 조언 금지.
- 위 번호를 붙일 수 없는 주장은 하지 마라.

## 학습자
한국 20대 남성 대학생. 맥락(선후배 존대, 조별과제, MT·회식, 발표 수업, 면접)을 안다.
흔한 패턴: 배경부터 길게 말하고 결론이 늦음, 감정 표현·스몰토크 회피, 불안을 무뚝뚝함으로
위장, 모르는 주제에서 침묵으로 이탈. 단, 실제 발화에서 확인된 것만 지적하라.
존댓말로, 훈계하지 말 것. 코치는 심판이 아니라 트레이너다.

## 판단 절차 (이 순서로 사고하라)
1 발화의 의도를 한 문장으로 규정한다.
2 청자로서 처음 듣는다고 가정하고 놓친 지점·지루한 지점을 표시한다.
3 위 원리 중 실제로 적용되는 것만 최대 3개 고른다.
4 발화의 실제 구절을 인용해 원리와 연결한다. 인용 없는 지적은 버린다.
5 개선은 딱 2가지로 압축한다.
6 다음에 시도할 행동 1가지를 30초 안에 실행 가능한 크기로 정한다.

## JSON 형식 주의 (반드시)
- 값 안에 큰따옴표(")를 쓰지 마세요. 인용은 따옴표 없이 쓰세요.
- 값 안에서 줄바꿈하지 마세요. 마지막 항목 뒤 콤마 금지.`;

  const SPEECH_SYSTEM = `당신은 한국 20대 남성 대학생을 위한 스피치 코치입니다.
전사문만 보고 판단하되, 이것이 '말'이라는 점을 잊지 마세요 — 글의 기준으로 재지 마세요.

${SPEECH_THEORY}

## 아래 JSON만 출력
{
 "scores":{"logic":1-5,"delivery":1-5,"audience":1-5,"confidence":1-5},
 "oneLine":"청자로서 들은 소감 한 문장. 솔직하게.",
 "listenerMoment":[{"type":"hooked|lost|bored|confused","quote":"발화의 실제 인용","note":"청자에게 일어난 일 한두 문장"}],
 "principle":[{"id":"원리 번호","name":"원리 이름","application":"이 발화에 어떻게 적용되는지"}],
 "fixes":[{"quote":"원래 발화","better":"이렇게 말했다면","why":"무엇이 달라지는지"}],
 "nextAction":"다음 발화에서 시도할 딱 한 가지 (30초 안에 실행 가능한 크기)"
}
listenerMoment는 3~4개, 최소 1개는 hooked를 포함. fixes는 1~2개.
점수는 후하게 주지 마세요. 3이 보통, 5는 예외적으로 뛰어날 때만.`;

  const SOCIAL_SYSTEM = `당신은 한국 20대 남성 대학생의 사회적 말하기를 돕는 코치입니다.
학습자가 특정 사회적 상황에서 한 말을 보고, 먼저 '상대가 어떻게 느꼈을지'를 시뮬레이션합니다.

${SPEECH_THEORY}

## 아래 JSON만 출력
{
 "partnerFeel":"상대가 느꼈을 것 한 문장. 긍정이면 왜, 부정이면 왜.",
 "partnerReply":"상대가 실제로 할 법한 다음 말 한 마디",
 "scores":{"face":1-5,"listening":1-5,"reciprocity":1-5,"warmth":1-5},
 "oneLine":"이 응답의 사회적 인상 한 문장",
 "principle":[{"id":"원리 번호","name":"원리 이름","application":"..."}],
 "fixes":[{"quote":"원래 말","better":"이렇게 말했다면","why":"상대가 어떻게 다르게 느끼는지"}],
 "upgrade":"이 대화를 한 단계 깊게 만들 다음 한 마디 (후속 질문 또는 자기개방)",
 "nextAction":"다음에 시도할 딱 한 가지"
}
점수는 후하게 주지 마세요. 3이 보통입니다. fixes는 1~2개.`;

  function speechUserMessage(L, transcript, take, prevNote, voice) {
    const sc = localSpeechScan(transcript);
    const dim = SPEECH_DIMS.find(d => d.key === L.dim);
    return `[과제] ${L.skill} — ${L.goal}
[겨냥하는 축] ${dim ? dim.label + ": " + dim.detail : L.dim || ""}
[상황] 준비 ${(L.speak || {}).prepSec || 0}초, 발화 ${(L.speak || {}).speakSec || 0}초
[제약] ${(L.constraints || []).join(" / ")}
${take > 1 ? `[리허설 ${take}회차] 직전 회차에서 코치가 준 과제: ${prevNote || "(없음)"}\n이번 발화에서 그것이 개선됐는지 먼저 확인하세요.\n` : ""}
[기계 분석 참고치 — 그대로 나열하지 말고 판단 근거로만]
글자 ${sc.chars} / 문장 ${sc.sentences}개, 평균 ${sc.meanLen}자 (40자 초과 ${sc.longSentences}개)
채움말 ${sc.fillers}회(문장당 ${sc.fillerPerSentence}) ${sc.fillerHits.slice(0, 6).join(",")}
신호어 ${sc.signposts}회 ${sc.signpostHits.slice(0, 5).join(",")} / 완충어 ${sc.hedges}회
결론 위치: ${sc.conclusion}${voicePromptLine(voice)}
[학습자 목표] ${state.goals || "(밝히지 않음)"}

[학습자 발화 전사]
${transcript}

판단 절차 1~6단계를 거쳐 JSON만 출력하세요.`;
  }

  function socialUserMessage(L, response, sceneText) {
    const sc = localSpeechScan(response);
    const dim = SOCIAL_DIMS.find(d => d.key === L.dim);
    return `[과제] ${L.skill} — ${L.goal}
[겨냥하는 축] ${dim ? dim.label + ": " + dim.detail : L.dim || ""}
[상황] ${sceneText || L.task}
[제약] ${(L.constraints || []).join(" / ")}
[기계 분석 참고치] 경청 표지 ${sc.listening}회 / 질문 표지 ${sc.questions}회 / 물음표 ${sc.questionMarks}개 / 완충어 ${sc.hedges}회

[학습자의 응답]
${response}

상대의 반응을 시뮬레이션하고 JSON만 출력하세요.`;
  }

  /* 썰 리포트 — 청중 반응 재생 + 구조 진단 */
  const AUD_UI = {
    laugh: ["aud-laugh", "😂", "여기서 터졌어요"],
    lean: ["aud-lean", "👀", "몸을 기울였어요"],
    drift: ["aud-drift", "😑", "딴생각이 들었어요"],
    confused: ["aud-confused", "❓", "못 따라갔어요"],
    flat: ["aud-flat", "😐", "그냥 지나갔어요"]
  };
  function renderStoryReport(rep) {
    if (!rep || !rep.scores) return "";
    const bars = STORY_DIMS.map(d => {
      const v = rep.scores[d.key] || 0;
      const pct = Math.max(0, Math.min(100, v / 5 * 100));
      const cls = v <= 2 ? "low" : v === 3 ? "mid" : "high";
      return `<div class="qbar-row" title="${esc(d.detail)}">
        <span class="qbar-label">${d.emoji} ${esc(d.label)}</span>
        <span class="qbar-track"><span class="qbar-fill ${cls}" style="width:${pct}%"></span></span>
        <span class="qbar-val ${cls}">${v}</span></div>`;
    }).join("");
    const vals = STORY_DIMS.map(d => rep.scores[d.key]).filter(v => typeof v === "number");
    const mean = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
    const aud = (rep.audience || []).map(a => {
      const st = AUD_UI[a.type] || AUD_UI.flat;
      return `<div class="aud-item ${st[0]}"><div class="aud-head">${st[1]} ${st[2]}</div>
        ${a.quote ? `<div class="quote-line">“${esc(a.quote)}”</div>` : ""}
        <div class="rr-note">${esc(a.note || "")}</div></div>`;
    }).join("");
    const s = rep.structure || {};
    const cell = (label, val, okVals) => {
      const ok = (okVals || []).indexOf(val) >= 0;
      return `<div class="struct-cell ${ok ? "ok" : "warn"}">
        <div class="sc-label">${esc(label)}</div><div class="sc-val">${esc(val || "-")}</div></div>`;
    };
    const fixes = (rep.fixes || []).map(f => `
      <div class="fb-block fb-surgery"><span class="fb-h">✂️ 이렇게 말했다면</span>
        ${f.quote ? `<div class="sg before"><span class="sg-tag">전</span>${esc(f.quote)}</div>` : ""}
        ${f.better ? `<div class="sg after"><span class="sg-tag">후</span>${esc(f.better)}</div>` : ""}
        ${f.why ? `<div class="sg why">→ ${esc(f.why)}</div>` : ""}</div>`).join("");
    const noPunch = /없/.test(rep.punchline || "");
    return `
      ${rep.oneLine ? `<div class="fb-block fb-now"><span class="fb-h">🎧 청중의 소감</span>${esc(rep.oneLine)}</div>` : ""}
      ${rep.punchline ? `<div class="fb-block ${noPunch ? "fb-improve" : "fb-praise"}">
        <span class="fb-h">💥 이 썰의 한 방</span>${esc(rep.punchline)}</div>` : ""}
      <div class="qscore-card">
        <div class="qscore-head"><span class="qscore-title">썰 6축</span>
          <span class="qscore-avg">평균 <b>${mean.toFixed(1)}</b> / 5</span></div>
        ${bars}
      </div>
      ${aud ? `<div class="section-label">🎧 듣는 동안 청중에게 일어난 일</div>${aud}` : ""}
      ${s.note || s.hook ? `
        <div class="section-label">🏗️ 구조 진단</div>
        <div class="struct-grid">
          ${cell("도입", s.hook, ["있음"])}
          ${cell("배경", s.background, ["적절"])}
          ${cell("전개", s.escalation, ["있음"])}
          ${cell("펀치 위치", s.punchPosition, ["끝"])}
        </div>
        ${s.note ? `<p class="muted small" style="margin-top:8px">${esc(s.note)}</p>` : ""}` : ""}
      ${fixes}
      ${rep.nextAction ? `<div class="fb-block fb-next"><span class="fb-h">➡️ 다음 회차에 딱 하나</span>${esc(rep.nextAction)}</div>` : ""}`;
  }

  /* 말하기·사회성 리포트 렌더 */
  function renderSpeechReport(rep, dims) {
    if (!rep || !rep.scores) return "";
    const D = dims || SPEECH_DIMS;
    const bars = D.map(d => {
      const v = rep.scores[d.key] || 0;
      const pct = Math.max(0, Math.min(100, v / 5 * 100));
      const cls = v <= 2 ? "low" : v === 3 ? "mid" : "high";
      return `<div class="qbar-row" title="${esc(d.detail)}">
        <span class="qbar-label">${d.emoji} ${esc(d.label)}</span>
        <span class="qbar-track"><span class="qbar-fill ${cls}" style="width:${pct}%"></span></span>
        <span class="qbar-val ${cls}">${v}</span></div>`;
    }).join("");
    const avg = D.map(d => rep.scores[d.key]).filter(v => typeof v === "number");
    const mean = avg.length ? (avg.reduce((a, b) => a + b, 0) / avg.length) : 0;
    const LM = {
      hooked: ["rr-good", "🎣", "귀가 열린 지점"], lost: ["rr-confused", "🌀", "놓친 지점"],
      bored: ["rr-bored", "😐", "지루해진 지점"], confused: ["rr-confused", "❓", "못 따라간 지점"]
    };
    const moments = (rep.listenerMoment || []).map(m => {
      const st = LM[m.type] || LM.hooked;
      return `<div class="rr-item ${st[0]}"><div class="rr-head">${st[1]} ${st[2]}</div>
        ${m.quote ? `<div class="quote-line">“${esc(m.quote)}”</div>` : ""}
        <div class="rr-note">${esc(m.note || "")}</div></div>`;
    }).join("");
    const partner = rep.partnerFeel ? `
      <div class="partner-box">
        <div class="partner-head">🧑 상대는 이렇게 느꼈을 거예요</div>
        <div class="partner-feel">${esc(rep.partnerFeel)}</div>
        ${rep.partnerReply ? `<div class="partner-reply">💬 “${esc(rep.partnerReply)}”</div>` : ""}
      </div>` : "";
    const principles = (rep.principle || []).map(p =>
      `<div class="principle-chip"><b>${esc(p.name || "")}</b>${p.id ? ` <span class="pn">#${esc(String(p.id))}</span>` : ""}
        <div>${esc(p.application || "")}</div></div>`).join("");
    const fixes = (rep.fixes || []).map(f => `
      <div class="fb-block fb-surgery"><span class="fb-h">✂️ 이렇게 말했다면</span>
        ${f.quote ? `<div class="sg before"><span class="sg-tag">전</span>${esc(f.quote)}</div>` : ""}
        ${f.better ? `<div class="sg after"><span class="sg-tag">후</span>${esc(f.better)}</div>` : ""}
        ${f.why ? `<div class="sg why">→ ${esc(f.why)}</div>` : ""}</div>`).join("");
    return `
      ${rep.oneLine ? `<div class="fb-block fb-now"><span class="fb-h">🗣️ 들은 소감</span>${esc(rep.oneLine)}</div>` : ""}
      ${partner}
      <div class="qscore-card">
        <div class="qscore-head"><span class="qscore-title">${dims === SOCIAL_DIMS ? "사회성 4축" : "말하기 4축"}</span>
          <span class="qscore-avg">평균 <b>${mean.toFixed(1)}</b> / 5</span></div>
        ${bars}
      </div>
      ${moments ? `<div class="section-label">듣는 동안 무슨 일이 있었나</div>${moments}` : ""}
      ${fixes}
      ${principles ? `<div class="section-label">적용된 원리</div><div class="principle-wrap">${principles}</div>` : ""}
      ${rep.upgrade ? `<div class="fb-block fb-next"><span class="fb-h">⬆️ 한 단계 깊게</span>${esc(rep.upgrade)}</div>` : ""}
      ${rep.nextAction ? `<div class="fb-block fb-next"><span class="fb-h">➡️ 다음 한 가지</span>${esc(rep.nextAction)}</div>` : ""}`;
  }

  /* ==================== 썰 코치 (구술 서사) ====================
   * 재미는 점수로 가르칠 수 없다. 그래서 '청중이 어디서 웃고 어디서 딴생각했는지'를
   * 재생해준다. 구술 서사 구조(도입-배경-사건-평가-해결)로 어디가 무너졌는지 진단한다. */
  const STORY_SYSTEM = `당신은 썰(구술 서사)을 듣는 청중이자, 이야기 구조를 아는 코치입니다.
학습자는 20대 남성 대학생이고, 사소한 일상을 재미있게 푸는 능력을 기르려 합니다.

## 이론 기반 (지적할 때 원리 이름을 밝힐 것)
1 구술 서사 구조(Labov): 좋은 썰은 도입(예고)-배경(최소)-사건(전개)-평가(왜 말할 가치가 있는지)
  -해결-여운으로 이뤄진다. 특히 '평가'가 없으면 청자가 '그래서 뭐?'라고 묻는다.
2 이야기할 가치(tellability): 사건 자체가 아니라 '왜 그게 이상하거나 놀라운지'가 이야기를 만든다.
3 관여 전략(Tannen): 재연 대사, 역사적 현재형('~하는 거야'), 구체적 디테일, 반복이
  청자를 장면 안으로 끌어들인다. 요약은 청자를 밖에 세운다.
4 정보 격차: 결말을 미리 흘리면 들을 이유가 사라진다. 궁금증을 유지하고 마지막에 해소하라.
5 부조화-해소: 웃음은 기대를 만든 뒤 어긋날 때 생긴다. 어긋남에는 뒤늦은 납득이 있어야 한다.
6 정점-종점 규칙: 사람은 정점과 마지막을 기억한다. 핵심 단어는 문장 끝에 와야 터진다.
7 삼단 구성: 두 번 반복해 패턴을 만들고 세 번째에 비튼다.
8 무해한 위반: 웃음은 '뭔가 잘못됐는데 안전할 때' 생긴다. 남을 깎는 웃음보다 자기를 낮추는
  웃음이 안전하고 호감을 만든다.
9 경제성: '늦게 들어가서 일찍 나와라'. 배경이 길거나 펀치 뒤에 설명이 붙으면 죽는다.
10 낙차: 사소한 사건 + 큰 내적 반응 = 썰. 사건의 크기가 아니라 반응의 크기가 이야기를 만든다.

## 오개념 금지
- '재미는 타고나는 것'이라는 식의 조언 금지. 모든 지적은 고칠 수 있는 구조·기술로 환원하라.
- 근거 없는 칭찬 금지. 웃긴 지점은 왜 웃긴지 원리로 설명하라.

## 판단 절차
1 이 썰의 '한 방'이 무엇인지 한 문장으로 규정한다. 없으면 없다고 판정한다.
2 청중으로서 처음 듣는다고 가정하고, 문장을 따라가며 반응이 일어난 지점을 표시한다.
3 구술 서사 구조 중 무너진 칸을 찾는다(도입/배경/사건/평가/해결).
4 실제 인용으로 근거를 대라. 인용 없는 지적은 버린다.
5 개선은 딱 2가지. 6 다음에 시도할 것 1가지.

## JSON 형식 주의
- 값 안에 큰따옴표(")를 쓰지 마세요. 값 안에서 줄바꿈하지 마세요. 마지막 항목 뒤 콤마 금지.

## 아래 JSON만 출력
{
 "scores":{"hook":1-5,"tension":1-5,"vivid":1-5,"punch":1-5,"economy":1-5,"involve":1-5},
 "punchline":"이 썰의 한 방이 무엇인지 한 문장. 없으면 '한 방이 없습니다'라고 쓰고 왜인지 덧붙일 것.",
 "oneLine":"청중으로서 들은 소감 한 문장. 솔직하게. 재미없으면 재미없다고.",
 "audience":[{"type":"laugh|lean|drift|confused|flat","quote":"발화의 실제 인용","note":"그 지점에서 청중에게 일어난 일"}],
 "structure":{"hook":"있음|약함|없음","background":"적절|너무 김|부족","escalation":"있음|평평함","punchPosition":"끝|중간|없음","note":"구조 진단 한두 문장"},
 "fixes":[{"quote":"원래 발화","better":"이렇게 말했다면","why":"어떤 원리로 더 터지는지"}],
 "nextAction":"다음 회차에서 시도할 딱 한 가지"
}
audience는 3~5개. type의 뜻 — laugh(웃음이 터짐) / lean(몸을 기울임, 궁금해짐) /
drift(딴생각이 듦) / confused(못 따라감) / flat(반응 없이 지나감).
점수는 후하게 주지 마세요. 대부분의 첫 시도는 2~3점입니다. 5는 정말 잘 터졌을 때만.`;

  function storyUserMessage(L, transcript, take, prevNote, topic, voice) {
    const sc = localSpeechScan(transcript);
    const st = localStoryScan(transcript);
    const dim = STORY_DIMS.find(d => d.key === L.dim);
    return `[과제] ${L.skill} — ${L.goal}
[겨냥하는 축] ${dim ? dim.label + ": " + dim.detail : L.dim || ""}
[소재] ${topic || "(자유)"}
[제약] ${(L.constraints || []).join(" / ")}
${take > 1 ? `[리허설 ${take}회차] 직전 회차의 과제: ${prevNote || "(없음)"}\n이번에 그것이 개선됐는지 먼저 확인하세요.\n` : ""}
[기계 분석 참고치 — 그대로 나열하지 말고 판단 근거로만]
글자 ${sc.chars} / 문장 ${sc.sentences}개, 평균 ${sc.meanLen}자
재연 대사 ${st.quotes}개 / 현재형 어미 ${st.present}회 / 청자 확인 ${st.invite}회 / 쉼 표시 ${st.pauses}개
채움말 ${sc.fillers}회 / 감정 설명어 ${st.tellEmotion}회(많으면 '설명하고 있다'는 신호)${voicePromptLine(voice)}

[학습자의 썰 전사]
${transcript}

판단 절차 1~6단계를 거쳐 JSON만 출력하세요.`;
  }

  /* 썰 전용 로컬 스캔 — 재연 대사·현재형·청자 확인·쉼 (API 0원) */
  function localStoryScan(text) {
    const t = String(text || "");
    return {
      /* 말로 하는 썰의 전사에는 따옴표가 거의 없다.
       * "내가 드세요 했는데" 처럼 종결어미 뒤에 인용 동사가 붙는 형태(FRAME)와
       * "뭐랬는지 알아?" 처럼 대사를 예고하는 형태(HERALD)까지 재연 대사로 센다. */
      quotes: countMatches(t, /['"“”'']([^'"“”'']{2,60})['"“”'']/g) +
              countMatches(t, /(라고|이러는|그러는|하는)\s*(거야|거예요|더라고|데)/g) +
              countMatches(t, /(요|다|야|어|지|까|니|래|대|군)\s+(하고|하더|하는\s*거|했는데|했어|했다|그러|이러|그랬|이랬|외치|소리치)/g) +
              countMatches(t, /뭐랬|뭐라(고|는)\s*(했|하|그)|무슨\s*말(을)?\s*했|하는\s*말이/g),
      present: countMatches(t, /(는|은)\s*거야|잖아|더라고|(하|되|오|가)는\s*거(야|예요)|는데\s*말이야/g),
      invite: countMatches(t, /알지\?|알아\?|있잖아|아니야\?|어이없지|그치\?|맞지\?|봐봐/g),
      pauses: countMatches(t, /\(\s*쉼\s*\)|\.\.\.|…/g),
      tellEmotion: countMatches(t, /웃겼|재밌었|황당했|어이없었|당황했|민망했|뻘쭘|짜증났|신기했/g),
      escalators: countMatches(t, /그러다|그러더니|근데\s*이게\s*끝이\s*아니|더\s*웃긴\s*건|심지어/g)
    };
  }
  function storyScanHTML(st, sc) {
    const row = (emoji, label, value, verdict, good) =>
      `<div class="scan-row"><span class="scan-k">${emoji} ${label}</span>
        <span class="scan-v"><b class="${good ? "sv-ok" : "sv-warn"}">${esc(value)}</b></span>
        <span class="scan-a">${esc(verdict)}</span></div>`;
    const rows = [];
    rows.push(row("🎬", "재연 대사", `${st.quotes}개`,
      st.quotes >= 2 ? "장면이 살아납니다." : "요약 대신 그때 오간 말을 그대로 옮겨보세요.", st.quotes >= 2));
    rows.push(row("⏱️", "현재형 재연", `${st.present}회`,
      st.present >= 3 ? "사건을 지금 벌어지는 일처럼 끌어왔어요." : "'~하는 거야/~잖아'로 바꾸면 훨씬 가까워집니다.", st.present >= 3));
    rows.push(row("🫵", "청자 확인", `${st.invite}회`,
      st.invite >= 1 ? "청자가 참여할 자리가 있어요." : "'그거 알지?', '어이없지?'로 끌어들여 보세요.", st.invite >= 1));
    rows.push(row("😐", "감정 설명어", `${st.tellEmotion}회`,
      st.tellEmotion === 0 ? "감정을 설명하지 않고 보여줬어요." : "'웃겼어/황당했어'는 청자가 느낄 몫입니다. 장면으로 보여주세요.",
      st.tellEmotion === 0));
    rows.push(row("🎢", "확대 표지", `${st.escalators}회`,
      st.escalators >= 1 ? "사건이 계단으로 커집니다." : "'그러더니', '근데 이게 끝이 아니야'로 단계를 만들어보세요.", st.escalators >= 1));
    return `<div class="scan-table">${rows.join("")}</div>`;
  }

  /* ==================== 롤플레이 (멀티턴 대화 시뮬레이션) ====================
   * 사회적 말하기는 혼자 연습할 수 없다는 것이 가장 큰 장벽이다.
   * AI가 코치가 아니라 '상대'로 반응해, 실제 대화 흐름 속에서 연습하게 한다.
   * 매 턴 <coach> 태그로 숨은 관찰을 남겨 대화 종료 후 복기에 쓴다. */
  const ROLEPLAY_SYSTEM = `당신은 지금 코치가 아니라 대화 상대입니다. 아래 인물이 되어 실제 사람처럼 반응하세요.

## 연기 규칙
- 응답은 1~3문장. 실제 대화처럼 짧게. 장황한 설명 금지.
- 친절 보정 금지. 상대(학습자)가 어색하게 말하면 어색해하고, 재미없으면 시들해지고,
  잘 받아주면 마음을 열어라. 당신의 반응이 곧 피드백이다.
- 학습자를 가르치거나 평가하지 마라. 인물로서 말할 뿐이다.
- 한국 대학생·직장 맥락의 자연스러운 한국어. 존댓말/반말은 인물 관계에 맞게.
- 대화가 끊길 상황이면 억지로 살리지 마라 — 짧게 답하고 침묵해도 된다.

## 출력 형식 (반드시 이 두 줄 구조)
<say>인물로서 하는 말</say>
<coach>학습자의 직전 발화에 대한 관찰 한 줄. 무엇을 잘했고 무엇이 아쉬웠는지. 학습자에게는 대화 중 보이지 않는다.</coach>
<mood>open|neutral|closing</mood>

mood는 지금 당신(인물)의 마음 상태다. 학습자가 잘하면 open, 그저 그러면 neutral,
대화가 식어가면 closing. 정직하게 판정하라.`;

  function roleplayUserMessage(scene, history, userTurn) {
    const lines = history.map(h => `${h.role === "user" ? "상대(학습자)" : "나"}: ${h.text}`).join("\n");
    return `[내가 연기할 인물] ${scene.persona}
[상황] ${scene.label}
[학습자의 연습 목표] ${scene.goal}

[지금까지의 대화]
${lines || "(아직 없음)"}
상대(학습자): ${userTurn}

인물로서 반응하세요. <say>/<coach>/<mood> 세 줄만 출력하세요.`;
  }

  function parseRoleplay(raw) {
    const t = String(raw || "");
    const say = (t.match(/<say>([\s\S]*?)<\/say>/) || [])[1];
    const coach = (t.match(/<coach>([\s\S]*?)<\/coach>/) || [])[1];
    const mood = (t.match(/<mood>([\s\S]*?)<\/mood>/) || [])[1];
    return {
      say: (say || t.replace(/<[^>]*>/g, "")).trim(),
      coach: (coach || "").trim(),
      mood: (mood || "neutral").trim().toLowerCase()
    };
  }

  /* 대화 종료 후 총평 — 사회성 4축 + 대화 전체 복기 */
  const ROLEPLAY_REVIEW_SYSTEM = `당신은 사회적 말하기 코치입니다. 학습자가 방금 마친 롤플레이 대화 전체를 보고 총평합니다.

${SPEECH_THEORY}

## 아래 JSON만 출력
{
 "scores":{"face":1-5,"listening":1-5,"reciprocity":1-5,"warmth":1-5},
 "oneLine":"이 대화의 인상 한 문장",
 "flow":"대화가 어떻게 흘렀는지 두 문장. 어디서 살아나고 어디서 식었는지.",
 "best":{"quote":"학습자의 가장 좋았던 말","why":"왜 효과적이었는지"},
 "miss":{"quote":"아쉬웠던 말","better":"이렇게 말했다면","why":"상대가 어떻게 다르게 느꼈을지"},
 "principle":[{"id":"원리 번호","name":"원리","application":"..."}],
 "nextAction":"다음 대화에서 시도할 딱 한 가지"
}
점수는 후하게 주지 마세요. 3이 보통입니다.`;

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
      revisions: [], revisePass: 0, qualityReport: null, qualityReportFinal: null,
      speechReport: null,
      aiFeedback: "", aiRetryFeedback: "", summary: "", selfRating: null,
      dim: lesson.dim || "",
      _lesson: lesson.track === "review" ? lesson : null // 복습 레슨은 동적이라 저장
    };
    if (lesson.track === "speak") {
      sess.topic = SPEAK_TOPICS[Math.floor(Math.random() * SPEAK_TOPICS.length)];
    }
    if (lesson.track === "story") {
      // 썰은 '사소한 소재'가 핵심이라 전용 소재 은행에서 뽑는다
      sess.topic = STORY_TOPICS[Math.floor(Math.random() * STORY_TOPICS.length)];
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
    renderModeBar();
    renderToday();
    renderProgress();
    renderLog();
    renderSettings();
  }

  function renderHeader() {
    updateHeaderUsage();
    const el = $("#header-day");
    if (!state.onboarded) { el.textContent = "진단 전"; return; }
    const active = state.activeSession;
    el.textContent = active ? `Day ${active.day}` : `Day ${state.currentDay}`;
  }
  /* AI 키가 있을 때만 노출 — 한도 이야기를 꺼낼 이유가 없으면 헤더를 비워둔다 */
  function updateHeaderUsage() {
    const el = $("#header-usage");
    if (!el) return;
    if (!aiReady()) { el.innerHTML = ""; return; }
    el.innerHTML = usageGaugeHTML();
  }

  /* ------------------------ 오늘 탭 (세션) ------------------------ */
  function renderToday() {
    renderHeader();
    const root = $("#session-root");
    if (!state.onboarded) { root.innerHTML = viewDiagnostic(); wireDiagnostic(); return; }
    if (state.diagnosis && state.diagnosis.status === "pending") {
      root.innerHTML = viewDiagnosing();
      runDiagnosis();
      return;
    }
    const sess = state.activeSession;
    if (!sess) { root.innerHTML = viewStart(); wireStart(); return; }

    const stageViews = {
      brief: [viewBrief, wireBrief],
      ritual: [viewRitual, wireRitual],
      write: [viewWrite, wireWrite],
      notice: [viewNotice, wireNotice],
      feedback: [viewFeedback, wireFeedback],
      retry: [viewRetry, wireRetry],
      "revise-more": [viewReviseMore, wireReviseMore],
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
      state.diagnosis = { status: "pending", text: text };
      recordActivity();
      save();
      renderAll();
      switchTab("tab-today");
    });
  }

  /* ==================== 진단 엔진 (AI 1회 호출 + 맞춤 커리큘럼) ==================== */
  function viewDiagnosing() {
    const withAI = aiReady();
    return `
    <div class="session-step">
      <div class="card" style="text-align:center; padding:30px 18px">
        <div style="font-size:38px">🔍</div>
        <h2 style="margin:8px 0 6px">진단 중입니다…</h2>
        <p class="muted small">${withAI
          ? "AI 코치가 당신의 글을 언어학·교육심리학 기준으로 분석하고, 맞춤 커리큘럼을 설계하고 있어요. (10~20초)"
          : "글의 문장·문단 지표를 분석하고 있어요."}</p>
        <p style="margin-top:14px"><span class="spinner"></span>분석 중</p>
      </div>
    </div>`;
  }

  const DIAG_SYSTEM = `당신은 한국어 글쓰기·말하기 진단 전문가입니다. 언어학·교육심리학·수사학 이론에 근거해
학습자의 첫 글을 진단하고 맞춤 커리큘럼을 설계합니다.

## 가장 먼저 할 일 — 목표 해석
학습자가 적은 목표를 먼저 읽고, **그 목표가 어떤 장르·상황의 글/말인지** 규정하세요.
그리고 그 장르에서 '잘한다'가 무엇인지 정한 뒤, **그 기준에 비추어** 진단하고 커리큘럼을 고르세요.
같은 글이라도 목표가 '업무 보고'면 간결성·두괄식이 급하고, '에세이'면 구체성·목소리가 급합니다.
기술을 고를 때마다 "이것이 이 사람의 목표에 왜 필요한가"를 답할 수 있어야 합니다.

진단 기준(이 틀로 분석하세요):
- 문장 수준: 간결성(군더더기), 능동/피동, 문장 길이 변주와 리듬, 종결어미 반복
- 문단 수준: 두괄식(핵심 선행), 한 문단 한 생각, 문장 간 논리적 응결성(cohesion)
- 글 전체: 구조(서론·본론·결론), 논증(주장-근거-예시), 독자 인식
- 스타일: 구체성(추상어 vs 감각어), 비유, 목소리(voice)
- 언어 발달 관점: Vygotsky의 근접발달영역 — 지금 혼자 되는 것과 도움받아 될 것을 구분

반드시 아래 JSON 형식만 출력하세요. 코드블록·설명·인사말 금지, JSON 외 텍스트 금지.
{
  "level": "초급|중급|상급",
  "levelWhy": "이 수준으로 판단한 근거를 한 문장",
  "summary": "총평 두 문장. 학습자의 글에서 실제로 관찰된 특징을 근거로.",
  "strengths": [{"point":"강점 이름","quote":"학습자 글에서 그대로 인용한 짧은 구절","why":"왜 좋은지 이론적으로 한 문장"}],
  "weaknesses": [{"skillId":"아래 목록의 id","label":"약점 이름","quote":"문제가 드러난 학습자 글의 짧은 인용","why":"무엇이 왜 문제인지 한두 문장","fix":"어떻게 고치면 되는지 한 문장"}],
  "goalRead": {
    "genre": "학습자가 잘하고 싶은 글/말의 종류를 한 마디로 (예: 업무 보고서, 발표 스피치, 에세이, 면접 답변)",
    "audience": "그 글/말의 독자·청자가 누구인가",
    "criteria": "그 장르에서 '잘한다'는 것이 무엇인지 두 문장. 이 학습자의 목표 기준으로.",
    "gap": "그 기준과 지금 글 사이의 가장 큰 간격 한 문장"
  },
  "writeFocus": ["구조 기술 id 4개 — 목표에 가까운 순서대로 (2주치)"],
  "speakFocus": ["말하기 기술 id 4개 — 순서대로 (2주치)"],
  "qualityFocus": ["품질 기술 id 4개 — 목표 장르에서 가장 중요한 품질 축부터 (2주치)"],
  "socialFocus": ["사회성 기술 id 4개 — 대화·관계 목표가 있을 때 (없으면 빈 배열)"],
  "focusWhy": {"기술id": "이 기술이 학습자의 목표에 왜 필요한지 한 문장. 목표를 직접 언급할 것."},
  "recommendCats": ["실전 말하기 카테고리 key 1~3개 — 목표와 관련된 것만"],
  "advice": "첫 주에 특히 신경 쓸 것을 3~4문장으로. 학습자의 목표와 연결해서."
}
목표가 비어 있으면 goalRead는 글 자체에서 추론하고, genre를 "(목표 미지정)"으로 두세요.
focusWhy에는 writeFocus·speakFocus·qualityFocus에 넣은 모든 id를 키로 포함하세요.
recommendCats는 다음 중에서만 고르세요: drink(술자리·회식), mt(모임·MT), present(발표·PT),
meeting(회의·미팅), interview(면접), work(직장 대화), events(경조사·행사), daily(일상 대화), relation(관계·감정).
strengths는 1~2개, weaknesses는 2~3개. quote는 반드시 학습자 글의 실제 표현이어야 합니다(없으면 빈 문자열).
skillId·writeFocus·speakFocus·qualityFocus는 반드시 주어진 id 목록에서만 고르세요.
weaknesses의 skillId는 구조·품질 목록 어디서든 고를 수 있습니다.

## JSON 형식 주의 (반드시)
- 값 안에 큰따옴표(")를 쓰지 마세요. 인용이 필요하면 홑따옴표(')나 그냥 따옴표 없이 쓰세요.
- 값 안에서 줄바꿈하지 마세요.
- 마지막 항목 뒤에 콤마를 붙이지 마세요.`;

  function diagUserMessage(text, goal) {
    const wl = WRITE_POOL.map(l => `${l.id}: ${l.skill}`).join("\n");
    const sl = SPEAK_POOL.map(l => `${l.id}: ${l.skill}`).join("\n");
    const ql = QUALITY_POOL.map(l => `${l.id}: ${l.skill} [${(dimOf(l.dim) || {}).label || l.dim}]`).join("\n");
    const sol = SOCIAL_POOL.map(l => `${l.id}: ${l.skill} [${(dimOf(l.dim) || {}).label || l.dim}]`).join("\n");
    const d = localDiagnose(text), m = d.metrics;
    return `[학습자 목표]
${goal || "(밝히지 않음)"}

[학습자의 첫 글]
${text}

[기계 분석 참고치 — 판단에 활용하되 그대로 나열하지 마세요]
글자 ${m.chars} / 문장 ${m.sentences} / 평균문장 ${m.mean}자(편차 ${m.sd}) / 문장길이 ${m.lens.join(",")}
군더더기후보 ${m.fillers} / 완충표현 ${m.hedges} / 피동 ${m.passives} / 접속사 ${m.connectors} / 이어붙임 ${m.conjTails}
감정어 ${m.emotionWords} / 감각어 ${m.senses} / 수치표현 ${m.numbers} / 동일종결어미연속 ${m.sameEnding}

[구조 기술 id 목록 — 문장·문단·글 전체]
${wl}

[말하기 기술 id 목록]
${sl}

[품질 기술 id 목록 — 개연성·흥미·어휘·밀도·목소리·독자 배려]
${ql}

[사회성 기술 id 목록 — 체면·경청·주고받기·온기]
${sol}

위 학습자를 진단하고 맞춤 커리큘럼을 JSON으로 설계하세요.`;
  }

  /* ---- JSON 파싱 견고화 ----
   * 모델은 인용문 안에 큰따옴표를 넣거나, 트레일링 콤마·스마트쿼트·생짜 개행을
   * 섞어 JSON을 깨뜨린다. 실패하면 단계적으로 복구해 다시 시도한다. */
  function escapeInnerQuotes(s) {
    let out = "", inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (esc) { out += c; esc = false; continue; }
      if (c === "\\") { out += c; esc = true; continue; }
      if (c === '"') {
        if (!inStr) { inStr = true; out += c; continue; }
        // 문자열 안에서 만난 " — 뒤에 구조 문자가 오면 종료, 아니면 값 속의 인용부호
        let j = i + 1;
        while (j < s.length && /\s/.test(s[j])) j++;
        const nx = s[j];
        if (nx === "," || nx === "}" || nx === "]" || nx === ":") { inStr = false; out += c; }
        else out += '\\"';
        continue;
      }
      if (inStr && (c === "\n" || c === "\r")) { out += "\\n"; continue; }  // 생짜 개행
      out += c;
    }
    return out;
  }
  /* 출력이 토큰 상한에 걸려 중간에 끊기면 닫는 괄호가 아예 없다 — 그런 JSON은
     따옴표·콤마를 고쳐도 못 살린다. 마지막으로 완결된 콤마 지점까지만 잘라내고
     (미완성 마지막 항목은 버림), 그 시점의 괄호 스택을 거꾸로 닫아 유효한 JSON을 만든다.
     최근 값 몇 개를 잃을 수 있지만, scores·oneLine 등 앞쪽 핵심 필드는 대개 살아남는다. */
  function repairTruncatedJSON(s) {
    let stack = [], inStr = false, esc = false;
    const cuts = [];  // { pos: 콤마 직전까지 자를 위치, stack: 그 시점의 괄호 스택 }
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { if (inStr) esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{" || c === "[") stack.push(c);
      else if (c === "}") { if (stack[stack.length - 1] === "{") stack.pop(); }
      else if (c === "]") { if (stack[stack.length - 1] === "[") stack.pop(); }
      else if (c === "," && stack.length) cuts.push({ pos: i, stack: stack.slice() });
    }
    for (let k = cuts.length - 1; k >= 0; k--) {
      const { pos, stack: snap } = cuts[k];
      let attempt = s.slice(0, pos);
      for (let j = snap.length - 1; j >= 0; j--) attempt += (snap[j] === "{" ? "}" : "]");
      try { return JSON.parse(attempt); } catch (e) { /* 다음 후보 시도 */ }
    }
    return null;
  }
  function extractJSON(s) {
    let t = String(s).trim();
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const a = t.indexOf("{");
    if (a < 0) throw new Error("JSON 형식이 아닙니다");
    const body = t.slice(a);                                  // 잘림 복구용 — 끝까지 전부
    const b = t.lastIndexOf("}");
    const bounded = b > a ? t.slice(a, b + 1) : body;          // 정상 응답용 — 마지막 '}'까지
    const noTrailing = (x) => x.replace(/,(\s*[}\]])/g, "$1");
    const smartToPlain = (x) => x.replace(/[‘’]/g, "'").replace(/[“”]/g, "'");
    const steps = [
      (x) => x,
      noTrailing,
      (x) => smartToPlain(noTrailing(x)),
      (x) => escapeInnerQuotes(x),
      (x) => escapeInnerQuotes(noTrailing(x)),
      (x) => escapeInnerQuotes(smartToPlain(noTrailing(x)))
    ];
    let lastErr = null;
    for (const f of steps) {
      try { return JSON.parse(f(bounded)); } catch (e) { lastErr = e; }
    }
    // 여기까지 실패했다면 응답이 중간에 잘렸을 가능성이 크다 — 마지막 완결 지점까지 복구 시도
    for (const f of steps) {
      const repaired = repairTruncatedJSON(f(body));
      if (repaired) return repaired;
    }
    throw new Error("응답이 도중에 잘렸어요. 다시 시도하면 보통 해결돼요 (" + (lastErr ? lastErr.message.slice(0, 50) : "parse") + ")");
  }

  /* 진단 결과를 실제 트랙 패턴의 날짜에 배치한다(패턴이 바뀌어도 따라간다) */
  function daysForTrack(track, fromDay, toDay) {
    const out = [];
    for (let d = fromDay; d <= toDay; d++) if (trackForDay(d) === track) out.push(d);
    return out;
  }
  /* fromDay 부터 2주치(14일)를 배치한다. 목표에 맞춘 순서를 오래 유지하려면
     1주만 짜서는 부족하다 — 2주차 이후 목표 영향이 사라지기 때문이다. */
  function buildPlanFromFocus(writeFocus, speakFocus, qualityFocus, fromDay, socialFocus) {
    const start = fromDay || 2;
    const end = start + 13;
    const pick = (ids, pool) => (ids || []).filter(id => pool.find(l => l.id === id));
    const map = [
      ["write", pick(writeFocus, WRITE_POOL)],
      ["speak", pick(speakFocus, SPEAK_POOL)],
      ["quality", pick(qualityFocus, QUALITY_POOL)],
      ["social", pick(socialFocus, SOCIAL_POOL)]
    ];
    const plan = {};
    map.forEach(([track, ids]) => {
      const days = daysForTrack(track, start, end);
      days.forEach((d, i) => { if (ids[i]) plan[String(d)] = ids[i]; });
    });
    return plan;
  }

  let _diagRunning = false;
  async function runDiagnosis() {
    if (_diagRunning) return;
    _diagRunning = true;
    const text = state.diagnosis.text || "";
    const local = localDiagnose(text);
    try {
      if (!aiReady()) throw new Error("__offline__");
      const raw = await callAI(DIAG_SYSTEM, diagUserMessage(text, state.goals), 3200, true);
      const j = extractJSON(raw);
      const weaknesses = (j.weaknesses || []).filter(w => w && byId(w.skillId));
      state.diagnosis = {
        status: "done", source: "ai",
        level: j.level || "", levelWhy: j.levelWhy || "",
        summary: j.summary || "", strengths: j.strengths || [],
        weaknesses: weaknesses, advice: j.advice || "", date: todayStr(),
        goalRead: j.goalRead || null, goalText: state.goals || ""
      };
      state.focusWhy = j.focusWhy || {};
      state.recommendCats = (j.recommendCats || []).filter(k => PRACTICE_CATS.find(c => c.key === k));
      state.planFrom = 2;
      state.plan = buildPlanFromFocus(j.writeFocus, j.speakFocus, j.qualityFocus, 2, j.socialFocus);
      // 약점을 기술 추적에 심어 간격 반복이 다시 꺼내게 한다
      weaknesses.forEach(w => {
        state.skills[w.skillId] = { rating: 1, seen: 0, lastDay: 0 };
      });
    } catch (e) {
      // 오프라인/실패 → 규칙 기반 진단으로 대체 (앱은 계속 동작)
      const ws = local.findings.map(f => {
        const l = byId(f.skillId);
        return { skillId: f.skillId, label: l ? l.skill : f.skillId, quote: "", why: f.why, fix: l ? l.goal : "" };
      });
      const m = local.metrics;
      state.diagnosis = {
        status: "done", source: e.message === "__offline__" ? "local" : "local-fallback",
        error: e.message === "__offline__" ? "" : e.message,
        level: m.chars >= 250 && m.sd > 12 ? "중급" : "초급",
        levelWhy: `분량 ${m.chars}자, 문장 ${m.sentences}개, 길이 편차 ${m.sd}자를 기준으로 한 개략 판정입니다.`,
        summary: `문장 ${m.sentences}개, 평균 ${m.mean}자로 썼습니다. 규칙 기반 지표에서 ${ws.length}가지 개선 지점이 보입니다.`,
        strengths: [{ point: "끝까지 완성", quote: "", why: "분량을 채워 완결한 것 자체가 산출(output) 훈련의 출발입니다." }],
        weaknesses: ws, advice: "AI 키를 설정하면 글의 내용까지 짚는 구체적 진단을 받을 수 있어요. 지금은 표면 지표 기준 커리큘럼으로 시작합니다.",
        date: todayStr()
      };
      const ofTrack = (t) => ws.filter(w => (byId(w.skillId) || {}).track === t).map(w => w.skillId);
      state.planFrom = 2;
      state.plan = buildPlanFromFocus(ofTrack("write"), ofTrack("speak"), ofTrack("quality"), 2, ofTrack("social"));
      ws.forEach(w => { state.skills[w.skillId] = { rating: 1, seen: 0, lastDay: 0 }; });
    }
    _diagRunning = false;
    save();
    renderToday();
    renderProgress();
  }

  /* ---- 목표 기반 재설계 ----
   * 목표를 수정했거나 2주 계획을 다 쓴 뒤, 그동안 쌓인 데이터로 다시 계획한다.
   * 전체 재진단(글 재분석)이 아니라 '계획'만 다시 짜므로 입력이 작다. */
  const PLAN_SYSTEM = `당신은 글쓰기·말하기 학습 커리큘럼 설계자입니다. 학습자의 목표와 그동안의 학습 데이터를 보고
다음 2주 커리큘럼을 설계합니다.

## 원칙
- 학습자의 목표가 최우선 기준입니다. 목표 장르에서 '잘한다'가 무엇인지 정하고, 그것에 가까워지는
  순서로 기술을 배열하세요. 같은 약점이라도 목표에 덜 중요하면 뒤로 미룹니다.
- 자기평가가 낮은 기술(아직 어려움)과 품질 점수가 낮은 축을 앞에 둡니다(의도적 연습).
- 이미 편해진 기술은 넣지 마세요(비계 제거).
- 각 기술마다 "이것이 이 목표에 왜 필요한가"를 목표를 직접 언급해 한 문장으로 밝히세요.

## 아래 JSON만 출력 (코드블록·설명 금지)
{
  "goalRead": {"genre":"목표 장르 한 마디","audience":"독자·청자","criteria":"그 장르에서 잘한다는 것 두 문장","gap":"지금과의 간격 한 문장"},
  "writeFocus": ["구조 기술 id 4개"],
  "qualityFocus": ["품질 기술 id 4개"],
  "speakFocus": ["말하기 기술 id 4개"],
  "socialFocus": ["사회성 기술 id 4개 (해당 없으면 빈 배열)"],
  "focusWhy": {"기술id":"목표와의 연결 한 문장"},
  "recommendCats": ["실전 카테고리 key 1~3개"],
  "advice": "다음 2주 학습 방향 3~4문장"
}
id는 반드시 주어진 목록에서만 고르세요.

## JSON 형식 주의 (반드시)
- 값 안에 큰따옴표(")를 쓰지 마세요. 인용이 필요하면 홑따옴표(')나 그냥 따옴표 없이 쓰세요.
- 값 안에서 줄바꿈하지 마세요.
- 마지막 항목 뒤에 콤마를 붙이지 마세요.`;

  function planUserMessage(fromDay) {
    const listOf = (pool) => pool.map(l => {
      const sk = state.skills[l.id];
      const mark = sk ? (sk.rating === 1 ? " [아직 어려움]" : sk.rating === 2 ? " [그럭저럭]" : " [편해짐]") : " [미학습]";
      return `${l.id}: ${l.skill}${l.dim ? ` (${(dimOf(l.dim) || {}).label || ""})` : ""}${mark}`;
    }).join("\n");
    const hist = state.quality || [];
    const qLine = hist.length
      ? QUALITY_DIMS.map(d => {
          const vals = hist.map(h => h.scores && h.scores[d.key]).filter(v => typeof v === "number");
          const avg = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : "-";
          return `${d.label} ${avg}`;
        }).join(" / ")
      : "(아직 독자 리포트 없음)";
    const recent = state.sessions.filter(s => s.lessonId !== "diagnostic").slice(-6)
      .map(s => `Day ${s.day} ${s.skill}${s.selfRating ? ` (자기평가 ${s.selfRating}/3)` : ""}`).join("\n") || "(없음)";
    return `[학습자 목표]
${state.goals || "(밝히지 않음)"}

[품질 6축 평균 — 낮은 축이 시급]
${qLine}

[최근 학습 이력]
${recent}

[구조 기술 목록]
${listOf(WRITE_POOL)}

[품질 기술 목록]
${listOf(QUALITY_POOL)}

[말하기 기술 목록]
${listOf(SPEAK_POOL)}

[사회성 기술 목록]
${listOf(SOCIAL_POOL)}

Day ${fromDay}부터 2주 커리큘럼을 목표에 맞춰 설계하세요.`;
  }

  let _planRunning = false;
  async function replanFromGoal(statusSel) {
    if (_planRunning || !aiReady()) return false;
    _planRunning = true;
    const st = statusSel ? $(statusSel) : null;
    if (st) { st.textContent = "목표에 맞춰 커리큘럼을 다시 설계하고 있어요…"; st.className = "notify-status"; }
    const fromDay = state.currentDay + 1;
    try {
      const raw = await callAI(PLAN_SYSTEM, planUserMessage(fromDay), 2800, true);
      const j = extractJSON(raw);
      const plan = buildPlanFromFocus(j.writeFocus, j.speakFocus, j.qualityFocus, fromDay, j.socialFocus);
      if (!Object.keys(plan).length) throw new Error("유효한 기술 id가 없습니다");
      state.plan = plan;
      state.planFrom = fromDay;
      state.focusWhy = Object.assign({}, state.focusWhy, j.focusWhy || {});
      state.recommendCats = (j.recommendCats || []).filter(k => PRACTICE_CATS.find(c => c.key === k));
      if (state.diagnosis) {
        state.diagnosis.goalRead = j.goalRead || state.diagnosis.goalRead;
        state.diagnosis.goalText = state.goals || "";
        if (j.advice) state.diagnosis.advice = j.advice;
      }
      state.planStale = false;
      save();
      if (st) { st.textContent = `Day ${fromDay}부터 2주 커리큘럼을 새로 짰어요.`; st.className = "notify-status ok"; }
      renderAll();
      return true;
    } catch (e) {
      if (st) { st.textContent = "재설계 실패: " + e.message; st.className = "notify-status err"; }
      return false;
    } finally { _planRunning = false; }
  }

  /* 목표가 커리큘럼에 어떻게 반영됐는지 보여주는 카드 */
  function viewGoalReflection() {
    const d = state.diagnosis;
    const gr = d && d.goalRead;
    const why = state.focusWhy || {};
    const planned = Object.keys(state.plan || {}).sort((a, b) => a - b);
    const rows = planned.map(day => {
      const l = byId(state.plan[day]);
      if (!l) return "";
      const r = why[l.id];
      return `<li><b>Day ${day}</b> · ${esc(l.skill)}${r ? `<div class="focus-why">${esc(r)}</div>` : ""}</li>`;
    }).filter(Boolean).join("");
    if (!gr && !rows) return "";
    return `
      <div class="card">
        <h2>🎯 목표가 커리큘럼에 반영된 방식</h2>
        ${state.goals ? `<div class="goal-quote">“${esc(state.goals)}”</div>` : `<p class="muted small">목표를 적으면 커리큘럼이 그 목표에 맞춰 재배치됩니다.</p>`}
        ${gr ? `
          <div class="goal-read">
            <div class="gr-row"><span class="gr-k">장르</span><span>${esc(gr.genre || "-")}</span></div>
            <div class="gr-row"><span class="gr-k">독자</span><span>${esc(gr.audience || "-")}</span></div>
            <div class="gr-row"><span class="gr-k">잘한다는 것</span><span>${esc(gr.criteria || "-")}</span></div>
            <div class="gr-row"><span class="gr-k">지금과의 간격</span><span>${esc(gr.gap || "-")}</span></div>
          </div>` : ""}
        ${rows ? `<div class="section-label">이 목표를 위해 이 순서로 훈련합니다</div>
          <ul class="plan-list why">${rows}</ul>` : ""}
      </div>`;
  }

  function viewDiagnosisReport() {
    const d = state.diagnosis;
    if (!d || d.status !== "done") return "";
    const st = (d.strengths || []).map(s => `
      <div class="fb-block fb-praise">
        <span class="fb-h">👏 ${esc(s.point || "강점")}</span>
        ${s.quote ? `<div class="quote-line">“${esc(s.quote)}”</div>` : ""}
        ${esc(s.why || "")}
      </div>`).join("");
    const wk = (d.weaknesses || []).map((w, i) => `
      <div class="fb-block fb-improve">
        <span class="fb-h">🎯 개선 ${i + 1} · ${esc(w.label || "")}</span>
        ${w.quote ? `<div class="quote-line">“${esc(w.quote)}”</div>` : ""}
        ${esc(w.why || "")}
        ${w.fix ? `<div class="fix-line">→ ${esc(w.fix)}</div>` : ""}
      </div>`).join("");
    const planRows = [];
    const pStart = state.planFrom || 2;
    for (let day = pStart; day <= pStart + 6; day++) {
      const t = trackForDay(day);
      if (t === "review") { planRows.push(`<li><b>Day ${day}</b> · 🔁 복습·통합</li>`); continue; }
      const sid = state.plan[String(day)];
      const l = sid ? byId(sid) : null;
      const icon = (TRACK_ICONS[t] || "").split(" ")[0] || "✍️";
      planRows.push(`<li><b>Day ${day}</b> · ${icon} ${l ? esc(l.skill) : esc(TRACK_NAMES[t] || t)}</li>`);
    }
    const badge = d.source === "ai"
      ? `<span class="src-badge ai">AI 진단</span>`
      : `<span class="src-badge local">규칙 기반 진단</span>`;
    return `
      <div class="card">
        <h2>🔍 진단 결과 ${badge}</h2>
        ${d.level ? `<div class="level-row"><span class="level-pill">${esc(d.level)}</span><span class="muted small">${esc(d.levelWhy || "")}</span></div>` : ""}
        <p class="why-text" style="margin-top:10px">${esc(d.summary || "")}</p>
        ${st}${wk}
        ${d.advice ? `<div class="fb-block" style="background:#f6f7fe;border:1px solid var(--line)">
          <span class="fb-h" style="color:var(--primary)">🧭 첫 주 조언</span>${esc(d.advice)}</div>` : ""}
        ${d.error ? `<p class="muted" style="font-size:12px">AI 진단 실패(${esc(d.error)}) — 규칙 기반으로 진행했습니다. 설정에서 키를 확인해보세요.</p>` : ""}
      </div>
      ${viewGoalReflection()}
      <div class="card">
        <h2>🗺️ 나에게 맞춘 커리큘럼</h2>
        <p class="muted small">목표와 진단 결과를 반영해 배치했어요. 진행하면서 자동으로 조정됩니다.</p>
        <ul class="plan-list">${planRows.join("")}</ul>
      </div>`;
  }

  /* ---- 세션 시작 화면 ---- */
  function viewStart() {
    const nextDay = state.currentDay + 1;
    const track = trackForDay(nextDay);
    const trackName = TRACK_NAMES[track] || "";
    const recall = lastLearnedLine();
    const doneToday = state.activity[todayStr()] ? true : false;
    // 진단 직후에는 진단 결과 + 맞춤 커리큘럼을 보여준다
    let preview = "";
    if (state.currentDay === 1) {
      preview = viewDiagnosisReport();
      if (!preview) {
        const plan = [];
        for (let d = 2; d <= 8; d++) {
          const t = trackForDay(d);
          const nm = TRACK_ICONS[t] || t;
          plan.push(`<li><b>Day ${d}</b> · ${nm}</li>`);
        }
        preview = `
        <div class="card">
          <h2>🗺️ 제안하는 첫 주 커리큘럼</h2>
          <p class="muted small">쓰기 4일 · 말하기 2일 · 복습 1일의 리듬으로 순환합니다.</p>
          <ul class="plan-list">${plan.join("")}</ul>
        </div>`;
      }
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
      ${trainCardHTML()}
    </div>`;
  }
  /* 오늘 탭에도 훈련 진행률을 띄운다 — 긴 과제가 부담스러운 날에도
     짧은 훈련은 할 수 있게 해서 연속 기록이 끊기지 않도록 한다. */
  function trainCardHTML() {
    const set = trainSet();
    const done = set.solved.length, total = set.items.length;
    if (!total) return "";
    const pct = Math.round(done / total * 100);
    const finished = done >= total;
    return `
      <div class="card" style="padding:16px">
        <h2 style="margin-bottom:6px">🏋️ 매일 훈련 <span class="sub">5분 · ${TRAIN_SET_SIZE}문항</span></h2>
        <p class="muted small">${finished
          ? "오늘 훈련을 다 마쳤어요. 내일 새 세트가 나옵니다 ✅"
          : "짧은 반복이 실력을 만듭니다. 시간이 없는 날엔 이것만 해도 좋아요."}</p>
        <div class="daily-bar" style="margin-top:10px">
          <div class="daily-head"><span>진행 <b>${done}/${total}</b></span>
            <span class="muted">⚡${state.train.xp || 0} XP</span></div>
          <div class="daily-track"><span class="daily-fill" style="width:${pct}%"></span></div>
        </div>
        <button class="btn ghost small" id="go-train" style="margin-top:12px">
          ${finished ? "훈련 다시 보기" : "훈련 시작"}</button>
      </div>`;
  }
  function wireStart() {
    $("#start-session").addEventListener("click", startNextSession);
    const gt = $("#go-train");
    if (gt) gt.addEventListener("click", () => {
      practiceMode = "train";
      switchTab("tab-practice");
      window.scrollTo(0, 0);
    });
  }

  /* ---- brief: 목표·미니레슨·과제 ---- */
  function viewBrief(sess, L) {
    const trackName = TRACK_NAMES[L.track];
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

      ${(state.focusWhy || {})[L.id] ? `<div class="fb-block fb-next">
        <span class="fb-h">🧭 내 목표와의 연결</span>${esc(state.focusWhy[L.id])}
      </div>` : ""}

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
    const L = lessonOf(sess);
    // 말하기는 발화 전 불안 리추얼을 한 번 거친다(회피를 막고 각성을 재해석)
    const next = ((L.track === "speak" || L.track === "story") && L.speak) ? "ritual" : "write";
    $("#to-write").addEventListener("click", () => { sess.stage = next; save(); renderToday(); });
  }

  /* ==================== 발표불안 모듈 ====================
   * 말 잘하기 이전에 불안이 병목인 학습자가 많다. 회피는 불안을 강화하므로
   * '불안을 없애는' 대신 '각성을 다르게 해석하고 주의를 밖으로 돌리는' 접근을 쓴다.
   * 말하기 과제 직전 90초 리추얼로 배치. API 0원. */
  function viewRitual(sess, L) {
    const steps = ANXIETY.ritual.map((r, i) => `
      <div class="ritual-step" data-i="${i}">
        <div class="rs-head"><span class="rs-n">${i + 1}</span>${esc(r.title)}
          <span class="rs-sec">${r.sec}초</span></div>
        <div class="rs-body">${esc(r.body)}</div>
      </div>`).join("");
    const card = ANXIETY.cards[Math.floor(Math.random() * ANXIETY.cards.length)];
    const lvl = state.anxiety && state.anxiety.level;
    return `
    <div class="session-step">
      <span class="step-kicker ${L.track}">DAY ${sess.day} · 말하기 전 준비</span>

      <div class="card">
        <h2>🧘 발화 전 90초</h2>
        <p class="muted small">불안은 없애는 게 아니라 다르게 쓰는 겁니다. 세 단계를 실제로 해보세요 —
        읽기만 하면 효과가 없습니다.</p>
        ${steps}
      </div>

      <div class="card anx-card">
        <div class="anx-head">💭 이런 생각이 드나요?</div>
        <div class="anx-fear">“${esc(card.fear)}”</div>
        <div class="anx-fact">${esc(card.fact)}</div>
      </div>

      <div class="card">
        <div class="section-label">지금 긴장도는 어느 정도인가요?</div>
        <div class="anx-scale">
          ${[1, 2, 3, 4, 5].map(n => `<button class="anx-lv ${lvl === n ? "on" : ""}" data-lv="${n}">${n}</button>`).join("")}
        </div>
        <div class="anx-scale-label"><span>편안함</span><span>매우 긴장</span></div>
        <p class="muted small" style="margin-top:8px">기록해두면 회차가 쌓일수록 변화가 보입니다.</p>
      </div>

      <button class="btn primary" id="ritual-done">준비됐어요 · 말하기 시작</button>
      <button class="btn ghost small" id="ritual-skip">건너뛰기</button>
    </div>`;
  }
  function wireRitual(sess, L) {
    $$(".anx-lv").forEach(b => b.addEventListener("click", () => {
      const lv = parseInt(b.getAttribute("data-lv"), 10);
      state.anxiety = state.anxiety || { log: [] };
      state.anxiety.level = lv;
      $$(".anx-lv").forEach(x => x.classList.toggle("on", x === b));
      save();
    }));
    const go = () => {
      // 긴장도를 세션에 기록해 추이로 남긴다
      if (state.anxiety && state.anxiety.level) {
        state.anxiety.log = state.anxiety.log || [];
        state.anxiety.log.push({ date: todayStr(), day: sess.day, level: state.anxiety.level });
        sess.anxietyBefore = state.anxiety.level;
        state.anxiety.level = null;
      }
      sess.stage = "write"; save(); renderToday();
    };
    $("#ritual-done").addEventListener("click", go);
    $("#ritual-skip").addEventListener("click", () => { sess.stage = "write"; save(); renderToday(); });
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
      ${micHTML(L)}
      <label style="margin-top:14px">✍️ 여기에 작성하세요
        <textarea id="submit-text" rows="10" data-limit="${limit || 0}" placeholder="${L.track === "speak" ? "말한 내용을 옮겨 적기…" : "과제를 여기에 작성하세요…"}">${esc(sess.submission)}</textarea>
      </label>
      <div class="char-count" id="submit-count">0자</div>
      <button class="btn primary" id="submit-btn">제출하기</button>
      <button class="btn ghost small" id="back-brief">← 레슨 다시 보기</button>
    </div>`;
  }
  /* ---- 음성 입력 (실제 발화 측정) ----
     말하기 과제에서만 뜬다. 브라우저가 지원 안 하면 조용히 숨고 타이핑이 그대로 남는다. */
  /* 실제 녹음이 있을 때만 프롬프트에 붙는다. 타이핑만 했다면 이 줄 자체가 없다 —
     없는 지표를 있는 척 넘기면 AI가 근거 없는 지적을 만들어낸다. */
  function voicePromptLine(v) {
    if (!v || v.seconds < 5) return "";   // 짧은 녹음의 분당 수치는 신뢰할 수 없다
    return `\n[실제 발화 측정 — 녹음에서 나온 값이므로 전사문보다 우선한다]
발화 ${v.seconds}초 / 말속도 ${v.wordsPerMin} 어절분 (편안한 구간 190~330)
쉼 ${v.pauseCount}회, 분당 ${v.pausePerMin}회 (편안한 구간 5~14), 가장 긴 쉼 ${v.longestPauseSec}초
침묵 비율 ${v.silentRatio}% / 채움말 분당 ${v.fillerPerMin}회
이 수치에서 드러나는 전달 습관(너무 빠름·쉼 없음·말문 막힘 등)이 있으면 반드시 짚어라.`;
  }
  function isSpeakingTrack(L) {
    return !!L && (L.track === "speak" || L.track === "social" || L.track === "story");
  }
  function micHTML(L) {
    if (!isSpeakingTrack(L) || typeof Voice === "undefined" || !Voice.supported()) return "";
    return `
      <div class="mic-box" id="mic-box">
        <button class="mic-btn" id="mic-btn" type="button"><span class="mic-dot"></span><span id="mic-label">🎙️ 말하면서 녹음하기</span></button>
        <div class="mic-meta"><span id="mic-time">0:00</span>
          <span class="muted">${Voice.transcriptSupported() ? "말하면 자동으로 받아 적어요" : "받아쓰기는 이 브라우저에서 안 돼요 — 속도·쉼만 측정됩니다"}</span></div>
        <p class="muted small" id="mic-hint">타이핑하면 실제 말하기 습관(속도·쉼·채움말)은 측정되지 않아요. 소리 내어 말해보세요.</p>
      </div>`;
  }
  /* 녹음 컨트롤을 특정 textarea에 붙인다. 끝나면 전사문을 넣고 지표를 세션에 저장한다. */
  let _voiceSession = null;
  function wireMic(sess, taSel, onDone) {
    const btn = $("#mic-btn");
    if (!btn) return;
    const label = $("#mic-label"), timeEl = $("#mic-time"), hint = $("#mic-hint");
    btn.addEventListener("click", async () => {
      const ta = $(taSel);
      if (_voiceSession) {                       // 정지
        const r = _voiceSession.stop();
        _voiceSession = null;
        btn.classList.remove("rec");
        label.textContent = "🎙️ 다시 녹음하기";
        if (r.text && ta) { ta.value = r.text; ta.dispatchEvent(new Event("input")); }
        sess.voice = r.metrics || null;
        save();
        if (hint && r.metrics) {
          hint.innerHTML = r.metrics.seconds < 5
            ? `${r.metrics.seconds}초는 너무 짧아 속도·쉼을 못 쟀어요. 10초 이상 말해보세요.`
            : `실제 발화 ${r.metrics.seconds}초 · ${r.metrics.wordsPerMin} 어절/분 · 쉼 ${r.metrics.pauseCount}회`;
        }
        if (onDone) onDone(r);
        return;
      }
      try {                                      // 시작
        _voiceSession = Voice.createSession({
          onText: (t) => { if (ta) { ta.value = t; ta.dispatchEvent(new Event("input")); } },
          onTick: (s) => { if (timeEl) timeEl.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); },
          onError: (m) => { if (hint) hint.textContent = m; }
        });
        await _voiceSession.start();
        btn.classList.add("rec");
        label.textContent = "⏹️ 멈추고 결과 보기";
        if (hint) hint.textContent = "듣고 있어요. 편하게 말해보세요.";
      } catch (e) {
        _voiceSession = null;
        if (hint) hint.textContent = "마이크를 쓸 수 없어요: " + e.message + " — 직접 타이핑해도 됩니다.";
      }
    });
  }
  /* 실제 발화 지표 표 — 타이핑으로는 절대 나올 수 없는 값들 */
  function voiceMetricsHTML(m) {
    if (!m) return "";
    const rows = Voice.judge(m).map(j =>
      `<div class="scan-row"><span class="scan-k">${esc(j.key)}</span>
        <span class="scan-v"><b class="${j.ok ? "sv-ok" : "sv-warn"}">${esc(j.value)}</b></span>
        <span class="scan-a">${esc(j.note)}</span></div>`).join("");
    return `<div class="section-label">🎙️ 실제 발화 측정 <span class="muted" style="text-transform:none">· 녹음에서만 나오는 값</span></div>
      <div class="scan-table">${rows}</div>`;
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
    wireMic(sess, "#submit-text");
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

  /* AI 피드백 슬롯 — 절약 모드면 버튼을 눌러야 호출된다 */
  function aiSlotHTML(slotId, askId, cached) {
    if (cached || !state.settings.aiSaver) {
      return `<div id="${slotId}" class="ai-fb-wrap">${cached ? "" : `<span class="spinner"></span>AI 코치가 분석하고 있어요…`}</div>`;
    }
    return `
      <div class="ai-ask-box">
        <div class="ai-ask-text">🤖 <b>AI 코치 피드백</b>을 받아볼까요?
          <span class="muted" style="font-size:12px">호출 1회 · 오늘 ${todayAIUsage()}회 사용</span></div>
        <button class="btn btn-secondary small" id="${askId}" style="margin:0">피드백 받기</button>
      </div>
      <div id="${slotId}" class="ai-fb-wrap"></div>`;
  }
  function aiOffHint() {
    return `<p class="muted small">💡 설정에서 <b>무료 Gemini 키</b>를 넣으면 이 글에 대한 이론 기반 맞춤 피드백을 받을 수 있어요.</p>`;
  }

  /* ---- feedback ---- */
  function viewFeedback(sess, L) {
    const useAI = aiReady();
    const isQuality = L.track === "quality";
    const isSpeech = L.track === "speak" || L.track === "social" || L.track === "story";
    /* 말하기·사회성 레슨은 전용 스피치 리포트를 1순위로 쓴다 */
    if (isSpeech) return viewSpeechFeedback(sess, L);
    const observation = localObservation(L, sess.submission);
    const scan = localQualityScan(sess.submission);
    /* 품질 레슨은 독자 리포트를, 구조 레슨은 기술 피드백을 기본으로 한다.
       어느 쪽이든 반대쪽도 버튼으로 추가 요청할 수 있다(각 1회 호출). */
    const primary = isQuality
      ? qualitySlotHTML(!!sess.qualityReport)
      : (useAI ? aiSlotHTML("ai-fb", "ai-ask", !!sess.aiFeedback) : aiOffHint());
    const secondary = !useAI ? "" : (isQuality
      ? (sess.aiFeedback
          ? `<div id="ai-fb" class="ai-fb-wrap">${renderAIFeedback(sess.aiFeedback)}</div>`
          : `<div class="ai-ask-box"><div class="ai-ask-text">🔧 <b>기술 피드백</b>도 받아볼까요?
               <span class="muted" style="font-size:12px">오늘 기술(${esc(L.skill)}) 관점 · 호출 1회</span></div>
             <button class="btn ghost small" id="ai-ask" style="margin:0">기술 피드백</button></div>
             <div id="ai-fb" class="ai-fb-wrap"></div>`)
      : (sess.qualityReport
          ? `<div id="q-fb">${renderQualityReport(sess.qualityReport)}</div>`
          : `<div class="ai-ask-box"><div class="ai-ask-text">🗣️ <b>독자 리포트</b>도 받아볼까요?
               <span class="muted" style="font-size:12px">개연성·흥미·어휘 6축 평가 · 호출 1회</span></div>
             <button class="btn btn-secondary small" id="q-ask" style="margin:0">독자 리포트</button></div>
             <div id="q-fb"></div>`));
    return `
    <div class="session-step">
      <span class="step-kicker ${L.track}">DAY ${sess.day} · 피드백</span>

      <div class="fb-block fb-praise">
        <span class="fb-h">👏 오늘의 노력</span>
        과제의 제약(${esc((L.constraints || [])[0] || "조건")})을 지키며 끝까지 완성했어요.
        ${sess.noticed ? "게다가 스스로 문제를 짚어낸 점이 특히 좋습니다 — 그게 성장의 핵심이에요." : "완성 자체가 산출(output) 훈련이에요."}
      </div>

      ${primary}
      ${secondary}

      <details class="hint-fold">
        <summary>기기 분석 · 코치 힌트 보기 (AI 없이 계산)</summary>
        <div class="fb-block fb-now" style="margin-top:4px">
          <span class="fb-h">📊 텍스트 지표</span>${observation}
        </div>
        <div class="fb-block fb-now">
          <span class="fb-h">🔍 표현 스캔</span>${qualityScanHTML(scan)}
        </div>
        ${(L.hints || []).slice(0, 2).map(h => `<div class="notice-q">→ ${esc(h)}</div>`).join("")}
      </details>

      <div class="fb-block" style="background:#f6f7fe;border:1px solid var(--line)">
        <span class="fb-h" style="color:var(--primary)">✏️ 다음 단계 · 수정</span>
        ${esc(revisePassInfo(L, 1).instruction)}
      </div>

      <button class="btn primary" id="to-retry">고쳐 쓰기 시작</button>
      <button class="btn ghost small" id="skip-retry">건너뛰고 마무리</button>
    </div>`;
  }
  /* ---- 말하기·사회성 전용 피드백 화면 ---- */
  function currentSpeechText(sess) {
    const revs = sess.revisions || [];
    return revs.length ? revs[revs.length - 1].text : sess.submission;
  }
  function viewSpeechFeedback(sess, L) {
    const isSocial = L.track === "social";
    const isStory = L.track === "story";
    const cur = currentSpeechText(sess);
    const sc = localSpeechScan(cur);
    const stScan = isStory ? localStoryScan(cur) : null;
    const cached = sess.speechReport;
    const take = sess.revisePass || 0;
    const total = revisePassCount(L);
    const renderRep = (r) => isStory ? renderStoryReport(r)
      : renderSpeechReport(r, isSocial ? SOCIAL_DIMS : SPEECH_DIMS);
    const slot = cached
      ? `<div id="sp-fb">${renderRep(cached)}</div>`
      : (!aiReady()
        ? `<div class="fb-block fb-improve"><span class="fb-h">${isStory ? "🎧 청중 반응" : isSocial ? "🧑 상대의 반응" : "🗣️ 청자 리포트"}</span>
             ${isStory ? "어디서 웃고 어디서 딴생각이 들었는지" : isSocial ? "상대가 어떻게 느꼈을지" : "듣는 사람에게 무슨 일이 일어났는지"}는 기계로 셀 수 없어 AI가 필요해요.
             설정에서 <b>무료 Gemini 키</b>를 넣으면 받을 수 있습니다.
             <br><span class="muted small">키가 없어도 아래 발화 지표는 그대로 계산됩니다.</span></div>`
        : (state.settings.aiSaver
          ? `<div class="ai-ask-box">
               <div class="ai-ask-text">${isStory ? "🎧 <b>청중 반응</b>을 재생할까요?" : isSocial ? "🧑 <b>상대의 반응</b>을 시뮬레이션할까요?" : "🗣️ <b>청자 리포트</b>를 받아볼까요?"}
                 <span class="muted" style="font-size:12px">${isStory ? "어디서 웃고 어디서 딴생각했는지 · 썰 6축" : isSocial ? "체면·경청·주고받기·온기 4축" : "논리·전달·청자조율·안정감 4축"} · 호출 1회 · 오늘 ${todayAIUsage()}회</span></div>
               <button class="btn btn-secondary small" id="sp-ask" style="margin:0">${isStory ? "청중 반응 보기" : isSocial ? "반응 보기" : "리포트 받기"}</button>
             </div><div id="sp-fb"></div>`
          : `<div id="sp-fb"><span class="spinner"></span>분석 중…</div>`));
    return `
    <div class="session-step">
      <span class="step-kicker ${L.track}">DAY ${sess.day} · ${take > 0 ? `${take}회차 피드백` : "피드백"}</span>

      <div class="fb-block fb-praise">
        <span class="fb-h">👏 오늘의 노력</span>
        ${isRehearsal(L) && take > 0
          ? `${take}회차까지 반복했어요. 리허설 반복은 1회 발화보다 훨씬 효과가 큽니다.`
          : "소리 내어 말하고 옮겨 적는 것 자체가 산출 훈련이에요."}
      </div>

      ${slot}

      <details class="hint-fold" open>
        <summary>📊 ${isStory ? "썰 장치 점검" : "발화 지표"} (기기에서 계산 · AI 없이)</summary>
        ${voiceMetricsHTML(sess.voice)}
        ${isStory ? storyScanHTML(stScan, sc) : speechScanHTML(sc)}
        ${(L.hints || []).slice(0, 2).map(h => `<div class="notice-q">→ ${esc(h)}</div>`).join("")}
      </details>

      <div class="fb-block" style="background:#f6f7fe;border:1px solid var(--line)">
        <span class="fb-h" style="color:var(--primary)">${isRehearsal(L) ? "🔁 다음 리허설" : "✏️ 다음 단계"}</span>
        ${esc(revisePassInfo(L, take + 1).instruction)}
      </div>

      <button class="btn primary" id="to-retry">${isRehearsal(L) ? `${take + 2}회차 말하기` : "다시 말하기"}</button>
      <button class="btn ghost small" id="skip-retry">건너뛰고 마무리</button>
    </div>`;
  }
  function wireSpeechFeedback(sess, L) {
    $("#to-retry").addEventListener("click", () => { sess.stage = "retry"; save(); renderToday(); });
    $("#skip-retry").addEventListener("click", () => { sess.stage = "wrap"; save(); renderToday(); });
    const isSocial = L.track === "social";
    const isStory = L.track === "story";
    const sys = isStory ? STORY_SYSTEM : isSocial ? SOCIAL_SYSTEM : SPEECH_SYSTEM;
    const dims = isStory ? STORY_DIMS : isSocial ? SOCIAL_DIMS : SPEECH_DIMS;
    const renderRep = (r) => isStory ? renderStoryReport(r) : renderSpeechReport(r, dims);
    const ask = () => {
      const prevNote = sess.speechReport && sess.speechReport.nextAction;
      const cur = currentSpeechText(sess);
      const take = (sess.revisePass || 0) + 1;
      const msg = isStory ? storyUserMessage(L, cur, take, prevNote, sess.topic, sess.voice)
        : isSocial ? socialUserMessage(L, cur, sess.topic)
        : speechUserMessage(L, cur, take, prevNote, sess.voice);
      requestSpeechReport("sp-fb", sys, msg, dims, (rep) => {
          sess.speechReport = rep; save();
          recordSpeech(rep, { day: sess.day, lessonId: L.id, track: L.track, take: sess.revisePass || 0 });
        }, renderRep);
    };
    if (sess.speechReport) {
      const el = $("#sp-fb");
      if (el) el.innerHTML = renderRep(sess.speechReport);
    } else {
      const b = $("#sp-ask");
      if (b) b.addEventListener("click", ask);
      else if (aiReady() && !state.settings.aiSaver) ask();
    }
  }
  async function requestSpeechReport(slotId, system, userMsg, dims, onDone, renderFn) {
    const slot = $("#" + slotId);
    if (slot) slot.innerHTML = `<span class="spinner"></span>분석 중…`;
    try {
      const raw = await callAI(system, userMsg, 3200, true);
      const j = extractJSON(raw);
      if (!j.scores) throw new Error("점수가 없습니다");
      if (onDone) onDone(j);
      const s2 = $("#" + slotId);
      if (s2) s2.innerHTML = (renderFn || ((r) => renderSpeechReport(r, dims)))(j);
      return j;
    } catch (e) {
      const s2 = $("#" + slotId);
      if (s2) s2.innerHTML = `<span style="color:var(--danger)">분석 실패: ${esc(e.message)}</span>
        <button class="btn ghost small" id="${slotId}-retry">다시 시도</button>`;
      const rb = $("#" + slotId + "-retry");
      if (rb) rb.addEventListener("click", () => requestSpeechReport(slotId, system, userMsg, dims, onDone, renderFn));
      return null;
    }
  }
  /* 말하기·사회성 점수 추이 기록 */
  function recordSpeech(rep, meta) {
    if (!rep || !rep.scores) return;
    state.speech = state.speech || [];
    state.speech.push({
      date: todayStr(), day: meta && meta.day, lessonId: meta && meta.lessonId,
      track: meta && meta.track, take: meta && meta.take,
      scores: rep.scores, oneLine: rep.oneLine || ""
    });
    save();
  }

  function qualitySlotHTML(cached) {
    if (cached) return `<div id="q-fb"></div>`;
    if (!aiReady()) {
      return `<div class="fb-block fb-improve"><span class="fb-h">🗣️ 독자 리포트</span>
        개연성·흥미·어휘 같은 <b>글의 수준</b>은 기계로 셀 수 없어서 AI 독자가 필요해요.
        설정에서 <b>무료 Gemini 키</b>를 넣으면 "여기서 지루해졌다 / 여기서 못 따라갔다"를 짚어줍니다.
        <br><span class="muted small">키가 없어도 아래 표현 스캔과 A/B 안목 훈련(실전 탭)으로 연습할 수 있어요.</span></div>`;
    }
    if (!state.settings.aiSaver) return `<div id="q-fb"><span class="spinner"></span>독자가 당신의 글을 읽고 있어요…</div>`;
    return `
      <div class="ai-ask-box">
        <div class="ai-ask-text">🗣️ <b>독자 리포트</b>를 받아볼까요?
          <span class="muted" style="font-size:12px">6축 평가 + 지루/혼란 지점 · 호출 1회 · 오늘 ${todayAIUsage()}회 사용</span></div>
        <button class="btn btn-secondary small" id="q-ask" style="margin:0">리포트 받기</button>
      </div>
      <div id="q-fb"></div>`;
  }
  function wireFeedback(sess, L) {
    if (L.track === "speak" || L.track === "social" || L.track === "story") return wireSpeechFeedback(sess, L);
    $("#to-retry").addEventListener("click", () => { sess.stage = "retry"; save(); renderToday(); });
    $("#skip-retry").addEventListener("click", () => { sess.stage = "wrap"; save(); renderToday(); });
    const askQuality = () => requestQualityReport("q-fb", sess.submission,
      `${L.category} · ${L.skill} 과제. 과제 지시: ${L.task}`,
      (rep) => { sess.qualityReport = rep; save(); recordQuality(rep, { day: sess.day, lessonId: L.id, pass: 0 }); });
    if (sess.qualityReport) { const q = $("#q-fb"); if (q) q.innerHTML = renderQualityReport(sess.qualityReport); }
    const qAsk = $("#q-ask"); if (qAsk) qAsk.addEventListener("click", askQuality);
    if (aiReady() && L.track === "quality" && !state.settings.aiSaver && !sess.qualityReport) askQuality();

    if (aiReady()) {
      const el = $("#ai-fb");
      if (sess.aiFeedback) { if (el) el.innerHTML = renderAIFeedback(sess.aiFeedback); }
      else {
        const ask = $("#ai-ask");
        if (ask) ask.addEventListener("click", () => requestAIFeedback(sess, L, sess.submission, "first"));
        if (!state.settings.aiSaver && L.track !== "quality") requestAIFeedback(sess, L, sess.submission, "first");
      }
    }
  }

  /* ---- retry ---- */
  function viewRetry(sess, L) {
    const pass = (sess.revisePass || 0) + 1;
    const info = revisePassInfo(L, pass);
    const total = revisePassCount(L);
    const prev = lastRevisionText(sess);
    const dim = info.focus ? dimOf(info.focus) : null;
    /* 말하기는 '수정'이 아니라 '리허설 반복' — 같은 주제를 다시 말한다 */
    if (isRehearsal(L)) return viewRehearsal(sess, L, pass, info, total, dim);
    return `
    <div class="session-step">
      <span class="step-kicker ${L.track}">DAY ${sess.day} · ${pass}차 수정</span>
      <div class="pass-dots">${Array.from({length: total}, (_, i) =>
        `<span class="pass-dot ${i + 1 < pass ? "done" : i + 1 === pass ? "now" : ""}">${i + 1}</span>`).join("")}</div>

      <div class="fb-block fb-next">
        <span class="fb-h">✏️ ${pass}차 수정의 초점 ${dim ? `· ${dim.emoji} ${esc(dim.label)}` : ""}</span>
        ${esc(info.instruction)}
        ${dim ? `<div class="sg why">${esc(dim.short)} — ${esc(dim.detail)}</div>` : ""}
      </div>

      ${pass > 1 ? `<details class="hint-fold"><summary>초고 보기</summary>
        <div class="ai-answer" style="margin:8px 0">${esc(sess.submission)}</div></details>` : `
        <div class="section-label">참고 · 처음 쓴 글</div>
        <div class="ai-answer">${esc(sess.submission)}</div>`}

      <label style="margin-top:14px">🔁 ${pass === 1 ? "고쳐 쓰기" : `${pass}차 수정본`}
        <textarea id="retry-text" rows="8" placeholder="${pass === 1 ? "피드백을 반영해 고쳐 보세요. 전체를 다시 써도 좋습니다." : "이번 초점에 맞춰 한 번 더 다듬어 보세요."}">${esc(prev)}</textarea>
      </label>
      <div class="char-count" id="retry-count">0자</div>
      <button class="btn primary" id="retry-submit">${pass < total ? `${pass}차 수정 제출` : "수정 완료"}</button>
      ${aiReady() ? `<div id="ai-retry-slot"></div>` : ""}
    </div>`;
  }
  /* 회차별 초점 — 말하기는 takes(리허설), 글쓰기는 revisePasses(수정) */
  function passSpec(L) { return L.takes || L.revisePasses || null; }
  function isRehearsal(L) { return !!L.takes; }
  /* 리허설은 '첫 발화(제출)'가 이미 1회차다. 따라서 takes[0]은 첫 발화의 초점이고,
     추가 리허설 회차는 takes[1]부터다. 글쓰기 수정은 초고 이후가 1차 수정이라 인덱스가 다르다. */
  function revisePassInfo(L, pass) {
    const rp = passSpec(L);
    if (isRehearsal(L)) {
      if (rp && rp[pass]) return rp[pass];          // pass=1 → takes[1] = 2회차
      return { focus: L.dim || null, instruction: L.retry || "한 번 더 말해보세요." };
    }
    if (rp && rp[pass - 1]) return rp[pass - 1];
    if (pass === 1) return { focus: L.dim || null, instruction: L.retry || "피드백을 반영해 고쳐 쓰세요." };
    return { focus: null, instruction: "한 번 더 다듬어 보세요." };
  }
  /* 추가로 진행할 회차 수 (첫 발화/초고 제외) */
  function revisePassCount(L) {
    const rp = passSpec(L);
    if (!rp) return 1;
    return isRehearsal(L) ? Math.max(1, rp.length - 1) : rp.length;
  }
  /* 화면에 보여줄 총 회차 (첫 발화 포함) */
  function totalTakes(L) {
    const rp = passSpec(L);
    return isRehearsal(L) && rp ? rp.length : revisePassCount(L) + 1;
  }
  function lastRevisionText(sess) {
    const revs = sess.revisions || [];
    if (revs.length) return revs[revs.length - 1].text;
    return sess.retry || sess.submission || "";
  }
  /* ---- 리허설 회차 화면 (말하기) ----
   * 글쓰기 '수정'과 달리 이전 원고를 고치는 게 아니라, 같은 주제를 처음부터 다시 말한다.
   * 이전 회차는 접어두고(보고 읽으면 리허설이 아니다), 지표 변화로 성장을 보여준다. */
  function viewRehearsal(sess, L, pass, info, _total, dim) {
    const takeNo = pass + 1;                 // 첫 발화가 1회차이므로 +1
    const total = totalTakes(L);
    const prevTake = (sess.revisions || [])[ (sess.revisions || []).length - 1 ];
    const prevText = prevTake ? prevTake.text : sess.submission;
    const prevScan = localSpeechScan(prevText);
    return `
    <div class="session-step">
      <span class="step-kicker ${L.track}">DAY ${sess.day} · 리허설 ${takeNo}/${total}회차</span>
      <div class="pass-dots">${Array.from({length: total}, (_, i) =>
        `<span class="pass-dot ${i + 1 < takeNo ? "done" : i + 1 === takeNo ? "now" : ""}">${i + 1}</span>`).join("")}</div>

      <div class="fb-block fb-next">
        <span class="fb-h">🔁 ${takeNo}회차 초점 ${dim ? `· ${dim.emoji} ${esc(dim.label)}` : ""}</span>
        ${esc(info.instruction)}
        ${dim ? `<div class="sg why">${esc(dim.short)}</div>` : ""}
      </div>

      ${sess.topic ? `<div class="topic-highlight">🎤 ${esc(sess.topic)}</div>` : ""}

      <div class="rehearse-note">
        📢 <b>보고 읽지 마세요.</b> 이전 회차는 접어뒀습니다. 다시 소리 내어 말한 뒤 옮겨 적으세요 —
        반복해서 <b>말하는 것</b>이 실력을 만듭니다.
      </div>

      <details class="hint-fold">
        <summary>직전 회차 보기 (${prevScan.chars}자 · 채움말 ${prevScan.fillers}회)</summary>
        <div class="ai-answer" style="margin:8px 0">${esc(prevText)}</div>
      </details>

      ${L.speak ? viewTimer(L) : ""}

      ${micHTML(L)}
      <label style="margin-top:14px">🎙️ ${takeNo}회차 발화
        <textarea id="retry-text" rows="8" placeholder="녹음 버튼을 누르고 말하거나, 직접 옮겨 적으세요"></textarea>
      </label>
      <div class="char-count" id="retry-count">0자</div>
      <button class="btn primary" id="retry-submit">${takeNo < total ? `${takeNo}회차 제출` : "리허설 완료"}</button>
    </div>`;
  }

  function wireRetry(sess, L) {
    const ta = $("#retry-text"), cc = $("#retry-count");
    const upd = () => { cc.textContent = charLen(ta.value) + "자"; };
    ta.addEventListener("input", upd); upd();
    wireMic(sess, "#retry-text");
    if (isRehearsal(L) && L.speak && $("#tm-start")) setupTimer();
    $("#retry-submit").addEventListener("click", () => {
      const text = ta.value.trim();
      if (charLen(text) < 5) { alert("고쳐 쓴 내용을 조금 더 적어 주세요."); return; }
      const pass = (sess.revisePass || 0) + 1;
      const info = revisePassInfo(L, pass);
      sess.revisions = sess.revisions || [];
      sess.revisions.push({ pass, focus: info.focus || "", text: text });
      sess.retry = text;              // 기록 호환
      sess.revisePass = pass;
      if (isRehearsal(L)) {
        // 리허설은 매 회차마다 피드백을 받고 다음 회차로 간다
        sess.speechReport = null;     // 새 회차는 새로 평가
        sess.stage = pass < revisePassCount(L) ? "feedback" : "wrap";
      } else {
        sess.stage = pass < revisePassCount(L) ? "revise-more" : "wrap";
      }
      save(); renderToday();
    });
  }

  /* ---- 회차 사이: 한 번 더 고칠지 선택 ---- */
  function viewReviseMore(sess, L) {
    const pass = sess.revisePass || 1;
    const next = revisePassInfo(L, pass + 1);
    const dim = next.focus ? dimOf(next.focus) : null;
    const cur = lastRevisionText(sess);
    return `
    <div class="session-step">
      <span class="step-kicker ${L.track}">DAY ${sess.day} · ${pass}차 수정 완료</span>
      <div class="card" style="padding:16px">
        <h2 style="margin-bottom:8px">✅ ${pass}차 수정을 마쳤어요</h2>
        <p class="muted small">품질은 초고가 아니라 수정에서 나옵니다. 같은 글을 다른 초점으로 한 번 더 다듬으면 눈에 띄게 좋아져요.</p>
        ${renderDiffPair("초고", sess.submission, `${pass}차`, cur)}
        <div class="fb-block fb-next" style="margin-top:14px">
          <span class="fb-h">➡️ 다음 초점 ${dim ? `· ${dim.emoji} ${esc(dim.label)}` : ""}</span>
          ${esc(next.instruction)}
        </div>
        <button class="btn primary" id="more-revise">한 번 더 고치기</button>
        <button class="btn ghost small" id="stop-revise">여기서 마무리</button>
      </div>
    </div>`;
  }
  function wireReviseMore(sess, L) {
    $("#more-revise").addEventListener("click", () => { sess.stage = "retry"; save(); renderToday(); });
    $("#stop-revise").addEventListener("click", () => { sess.stage = "wrap"; save(); renderToday(); });
  }
  /* 초고 vs 수정본 나란히 보기 */
  function renderDiffPair(labelA, textA, labelB, textB) {
    const ma = metrics(textA), mb = metrics(textB);
    return `
      <div class="diff-pair">
        <div class="diff-col">
          <div class="diff-h before">${esc(labelA)} <span>${ma.chars}자 · ${ma.sentences}문장</span></div>
          <div class="diff-body">${esc(textA)}</div>
        </div>
        <div class="diff-col">
          <div class="diff-h after">${esc(labelB)} <span>${mb.chars}자 · ${mb.sentences}문장</span></div>
          <div class="diff-body">${esc(textB)}</div>
        </div>
      </div>`;
  }

  /* ---- wrap: 초고/최종본 비교 + 자기평가 + 인출 요약 ---- */
  function viewWrap(sess, L) {
    const final = lastRevisionText(sess);
    const revised = (sess.revisions || []).length > 0 && final !== sess.submission;
    /* 초고와 최종본 점수를 비교할 수 있으면 성장을 수치로 보여준다 */
    let growth = "";
    if (sess.qualityReport && sess.qualityReportFinal) {
      const a = qualityAvg(sess.qualityReport.scores), b = qualityAvg(sess.qualityReportFinal.scores);
      const diff = b - a;
      growth = `<div class="fb-block ${diff >= 0 ? "fb-praise" : "fb-improve"}">
        <span class="fb-h">📈 초고 → 최종본</span>
        품질 평균 <b>${a.toFixed(1)}</b> → <b>${b.toFixed(1)}</b>
        (${diff >= 0 ? "+" : ""}${diff.toFixed(1)})
      </div>`;
    }
    /* 리허설(말하기)은 회차별 지표 변화로 성장을 보여준다 */
    if (isRehearsal(L) && (sess.revisions || []).length) {
      const takes = [{ text: sess.submission }].concat(sess.revisions);
      const rows = takes.map((t, i) => {
        const s = localSpeechScan(t.text);
        return `<tr><td>${i + 1}회차</td><td>${s.chars}자</td><td>${s.fillers}회</td>
          <td>${s.signposts}회</td><td>${s.meanLen}자</td><td>${esc(s.conclusion)}</td></tr>`;
      }).join("");
      const first = localSpeechScan(takes[0].text), last = localSpeechScan(takes[takes.length - 1].text);
      const dF = last.fillers - first.fillers, dS = last.signposts - first.signposts;
      return viewWrapBody(sess, L, `
        <div class="section-label">🔁 리허설 회차별 변화</div>
        <div class="take-table-wrap"><table class="take-table">
          <thead><tr><th>회차</th><th>분량</th><th>채움말</th><th>신호어</th><th>평균문장</th><th>결론</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
        <div class="fb-block ${dF <= 0 && dS >= 0 ? "fb-praise" : "fb-improve"}">
          <span class="fb-h">📈 1회차 → ${takes.length}회차</span>
          채움말 ${first.fillers}→${last.fillers}회 (${dF > 0 ? "+" : ""}${dF}) ·
          신호어 ${first.signposts}→${last.signposts}회 (${dS > 0 ? "+" : ""}${dS}) ·
          결론 위치 ${esc(first.conclusion)} → ${esc(last.conclusion)}
          <div class="sg why">반복해서 말할수록 채움말이 줄고 구조가 잡히는 것이 정상입니다.</div>
        </div>`);
    }
    const compareBlock = revised ? `
      <div class="section-label">🔍 초고와 최종본 비교 <span class="muted">(수정이 만든 차이)</span></div>
      ${renderDiffPair("초고", sess.submission, "최종본", final)}
      ${growth}
      ${aiReady() && !sess.qualityReportFinal ? `
        <div class="ai-ask-box">
          <div class="ai-ask-text">🗣️ <b>최종본</b>도 독자 리포트를 받아 초고와 비교할까요?
            <span class="muted" style="font-size:12px">호출 1회</span></div>
          <button class="btn btn-secondary small" id="final-q-ask" style="margin:0">최종본 평가</button>
        </div>
        <div id="q-final"></div>` : `<div id="q-final"></div>`}
    ` : "";
    return viewWrapBody(sess, L, compareBlock);
  }
  /* 마무리 화면의 공통 부분 (비교 블록만 트랙별로 다르다) */
  function viewWrapBody(sess, L, compareBlock) {
    const isSpeech = L.track === "speak" || L.track === "social" || L.track === "story";
    return `
    <div class="session-step">
      <span class="step-kicker ${L.track}">DAY ${sess.day} · 마무리</span>

      ${compareBlock || ""}

      <div class="section-label">오늘 이 기술, 얼마나 익혔나요? <span class="muted">(다음 과제 난이도 조절에 쓰여요)</span></div>
      <div class="timer-controls" style="justify-content:stretch; gap:8px; margin-top:8px">
        <button class="btn ghost small rate" data-r="1" style="flex:1;margin:0">😥 아직 어려워요</button>
        <button class="btn ghost small rate" data-r="2" style="flex:1;margin:0">🙂 그럭저럭</button>
        <button class="btn ghost small rate" data-r="3" style="flex:1;margin:0">😎 편해졌어요</button>
      </div>
      <p class="notify-status" id="rate-status"></p>

      <div class="section-label" style="margin-top:18px">오늘 배운 것을 한 문장으로 <span class="muted">(인출 연습 — 직접 말해봐야 남아요)</span></div>
      <textarea id="wrap-summary" rows="2" placeholder="${isSpeech ? "예: 결론을 먼저 말하면 청자가 끝까지 따라온다" : "예: 핵심 주장을 문단 맨 앞에 두면 글이 또렷해진다"}">${esc(sess.summary)}</textarea>

      <button class="btn primary" id="finish-session">세션 마무리</button>
    </div>`;
  }
  function wireWrap(sess, L) {
    const fq = $("#final-q-ask");
    if (fq) fq.addEventListener("click", () => {
      requestQualityReport("q-final", lastRevisionText(sess),
        `${L.category} · ${L.skill} 과제의 수정 최종본`,
        (rep) => {
          sess.qualityReportFinal = rep; save();
          recordQuality(rep, { day: sess.day, lessonId: L.id, pass: sess.revisePass || 1 });
          renderToday();
        });
    });
    if (sess.qualityReportFinal) { const q = $("#q-final"); if (q) q.innerHTML = renderQualityReport(sess.qualityReportFinal); }
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
      dim: sess.dim || "",
      submission: sess.submission, noticed: sess.noticed, retry: sess.retry,
      revisions: sess.revisions || [],
      qualityScores: sess.qualityReport ? sess.qualityReport.scores : null,
      qualityScoresFinal: sess.qualityReportFinal ? sess.qualityReportFinal.scores : null,
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
    syncNotifyToIdb();  // 오늘 이미 했다는 사실을 백그라운드 알림도 알 수 있게 즉시 복사
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
    g.className = state.goals ? "goal-quote" : "muted";
    // 목표 해석 + 계획 상태
    const grBox = $("#goal-read-box");
    if (grBox) {
      const gr = state.diagnosis && state.diagnosis.goalRead;
      const planEnd = state.planFrom ? state.planFrom + 13 : 0;
      const runningOut = planEnd && state.currentDay >= planEnd - 2;
      let html = "";
      if (gr) {
        html += `<div class="goal-read">
          <div class="gr-row"><span class="gr-k">장르</span><span>${esc(gr.genre || "-")}</span></div>
          <div class="gr-row"><span class="gr-k">독자</span><span>${esc(gr.audience || "-")}</span></div>
          <div class="gr-row"><span class="gr-k">잘한다는 것</span><span>${esc(gr.criteria || "-")}</span></div>
        </div>`;
      }
      if (state.planStale) {
        html += `<p class="plan-warn">⚠️ 목표가 바뀐 뒤 커리큘럼을 다시 짜지 않았어요. 아래 ‘다시 계획’을 눌러주세요.</p>`;
      } else if (runningOut) {
        html += `<p class="plan-warn">📅 계획한 2주가 거의 끝났어요. ‘다시 계획’으로 다음 2주를 목표에 맞춰 받으세요.</p>`;
      } else if (state.planFrom) {
        html += `<p class="muted small">현재 계획: Day ${state.planFrom}~${planEnd} (목표 기준으로 배치됨)</p>`;
      }
      grBox.innerHTML = html;
    }

    // 기술 그리드 — 트랙별로 묶어서 표시
    const grid = $("#skill-grid");
    const chip = (l) => {
      const sk = state.skills[l.id];
      const cls = !sk ? "d-none" : sk.rating === 1 ? "d-weak" : sk.rating === 2 ? "d-mid" : sk.rating >= 3 ? "d-strong" : "d-none";
      return `<div class="skill-chip"><span class="sname">${esc(l.skill.split(" — ")[0])}</span><span class="dot ${cls}"></span></div>`;
    };
    grid.innerHTML = MODE_TRACKS[currentMode()].map(t => {
      const pool = POOLS[t] || [];
      if (!pool.length) return "";
      return `<div class="skill-group"><div class="skill-group-h">${TRACK_ICONS[t] || t}</div>
        <div class="skill-group-grid">${pool.map(chip).join("")}</div></div>`;
    }).join("");

    renderPresetGrid();
    renderAnxietyPanel();
    renderQualityPanel();
    renderDrillStat();
    renderHeatmap();
    renderWeeklyReview();
  }

  /* 훈련 비중 프리셋 선택 */
  function renderPresetGrid() {
    const el = $("#preset-grid");
    if (!el) return;
    el.innerHTML = Object.keys(TRACK_PRESETS).map(k => {
      const p = TRACK_PRESETS[k];
      const counts = {};
      p.pattern.forEach(t => { counts[t] = (counts[t] || 0) + 1; });
      const mix = Object.keys(counts).map(t => `${(TRACK_ICONS[t] || t).split(" ")[0]}${counts[t]}`).join(" ");
      return `<button class="preset-btn ${state.preset === k ? "on" : ""}" data-preset="${k}">
        <div class="pb-label">${esc(p.label)}</div>
        <div class="pb-desc">${esc(p.desc)}</div>
        <div class="pb-mix">${mix}</div>
      </button>`;
    }).join("");
    $$(".preset-btn").forEach(b => b.addEventListener("click", () => {
      setPreset(b.getAttribute("data-preset"), "#preset-status");
    }));
  }

  /* 프리셋 전환 — 진도 탭의 5종 그리드와 상단 글쓰기/말하기 퀵 스위치가 함께 쓴다 */
  function setPreset(k, statusSel) {
    if (!TRACK_PRESETS[k] || k === state.preset) return;
    state.preset = k;
    // 프리셋이 바뀌면 기존 계획의 트랙이 안 맞으므로 계획을 비운다
    state.plan = {}; state.planFrom = 0; state.planStale = !!state.goals;
    save(); renderProgress(); renderToday(); renderModeBar(); renderPractice();
    if (statusSel) {
      setStatus(statusSel, `‘${TRACK_PRESETS[k].label}’으로 바꿨어요. 다음 세션부터 적용됩니다.` +
        (state.goals ? " 목표에 맞춰 다시 계획하면 더 정확해져요." : ""), "ok");
    }
  }

  /* 헤더 아래 상시 노출되는 글쓰기 ↔ 말하기 퀵 스위치.
     세밀한 5종 프리셋(진도 탭)이 있지만, 매일 쓰기엔 이 이진 스위치 하나로 충분하다.
     writing만 '글쓰기' 쪽이고 나머지(균형/말하기/썰/사회성)는 전부 말하기 비중이 있어 '말하기' 쪽으로 묶는다. */
  function renderModeBar() {
    const bar = $("#mode-bar");
    if (!bar) return;
    if (!state.onboarded) { bar.style.display = "none"; return; }
    bar.style.display = "";
    const speaking = state.preset !== "writing";
    const sw = $("#mode-switch");
    sw.setAttribute("aria-checked", String(speaking));
    sw.classList.toggle("on", speaking);
    $("#mode-bar").classList.toggle("on", speaking);
  }
  function wireModeBar() {
    $("#mode-switch").addEventListener("click", () => {
      const speaking = state.preset !== "writing";
      setPreset(speaking ? "writing" : "speaking", null);
      renderModeBar();
    });
  }

  /* 긴장도 추이 — 노출 반복으로 줄어드는지 보여준다 */
  function renderAnxietyPanel() {
    const card = $("#anxiety-card"), el = $("#anxiety-panel");
    if (!card || !el) return;
    if (currentMode() === "write") { card.style.display = "none"; return; }
    const log = (state.anxiety && state.anxiety.log) || [];
    if (!log.length) { card.style.display = "none"; return; }
    card.style.display = "block";
    const bars = log.slice(-14).map(l =>
      `<span class="anx-bar" style="height:${l.level / 5 * 100}%" title="Day ${l.day}: ${l.level}/5"></span>`).join("");
    const first = log[0].level, last = log[log.length - 1].level;
    const avg = (log.reduce((a, b) => a + b.level, 0) / log.length).toFixed(1);
    const diff = last - first;
    return el.innerHTML = `
      <p class="muted small">말하기 ${log.length}회 기록 · 평균 ${avg}/5
        ${log.length > 1 ? `· 처음 ${first} → 최근 ${last} <b class="${diff < 0 ? "sv-ok" : diff > 0 ? "sv-warn" : ""}">(${diff > 0 ? "+" : ""}${diff})</b>` : ""}</p>
      <div class="anx-chart">${bars}</div>
      <p class="muted small" style="margin-top:8px">${diff < 0
        ? "반복 노출로 긴장이 줄고 있어요. 회피하지 않은 것이 효과를 만들고 있습니다."
        : log.length < 3 ? "몇 회 더 쌓이면 변화가 보입니다. 불안은 회피하면 커지고 반복하면 줄어듭니다."
        : "아직 긴장이 높네요. 준비 시간이 긴 짧은 과제부터 다시 쌓아보세요."}</p>`;
  }

  /* 품질 6축 추이 — 첫 리포트 대비 최신 리포트, 축별 평균과 스파크라인 */
  function renderQualityPanel() {
    const card = $("#quality-card"), el = $("#quality-panel");
    if (!card || !el) return;
    if (currentMode() === "speak") { card.style.display = "none"; return; }
    const hist = state.quality || [];
    if (!hist.length) { card.style.display = "none"; return; }
    card.style.display = "block";
    const first = hist[0], last = hist[hist.length - 1];
    const rows = QUALITY_DIMS.map(d => {
      const vals = hist.map(h => h.scores && h.scores[d.key]).filter(v => typeof v === "number");
      if (!vals.length) return "";
      const cur = vals[vals.length - 1], f = vals[0];
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const diff = vals.length > 1 ? cur - f : 0;
      const pct = Math.max(0, Math.min(100, cur / 5 * 100));
      const cls = cur <= 2 ? "low" : cur === 3 ? "mid" : "high";
      const spark = vals.slice(-8).map(v => `<span class="spark-bar" style="height:${Math.max(12, v / 5 * 100)}%" title="${v}"></span>`).join("");
      return `<div class="qtrend-row">
        <span class="qbar-label">${d.emoji} ${esc(d.label)}</span>
        <span class="qbar-track"><span class="qbar-fill ${cls}" style="width:${pct}%"></span></span>
        <span class="qbar-val ${cls}">${cur}</span>
        <span class="spark">${spark}</span>
        <span class="qtrend-diff ${diff > 0 ? "up" : diff < 0 ? "down" : ""}">${diff > 0 ? "▲" + diff : diff < 0 ? "▼" + Math.abs(diff) : "–"}</span>
        <span class="qtrend-avg">평균 ${avg.toFixed(1)}</span>
      </div>`;
    }).join("");
    const a = qualityAvg(first.scores || {}), b = qualityAvg(last.scores || {});
    const weak = weakestQualityDim();
    const wd = weak ? dimOf(weak) : null;
    el.innerHTML = `
      <p class="muted small">리포트 <b>${hist.length}</b>회 누적 · 전체 평균 ${a.toFixed(1)} → <b>${b.toFixed(1)}</b>
      ${hist.length > 1 ? `(${b - a >= 0 ? "+" : ""}${(b - a).toFixed(1)})` : ""}</p>
      <div class="qtrend">${rows}</div>
      ${wd ? `<div class="fb-block fb-improve" style="margin-top:12px">
        <span class="fb-h">🎯 지금 가장 약한 축 · ${wd.emoji} ${esc(wd.label)}</span>
        ${esc(wd.detail)}<div class="sg why">품질 트랙 과제가 이 축을 우선 겨냥합니다.</div></div>` : ""}
      ${last.oneLine ? `<div class="recall-line" style="margin-top:10px">🗣️ 최근 독자의 한마디: <b>${esc(last.oneLine)}</b></div>` : ""}`;
  }

  function renderDrillStat() {
    const card = $("#drill-stat-card"), el = $("#drill-stat");
    if (!card || !el) return;
    if (currentMode() === "speak") { card.style.display = "none"; return; }
    const d = state.drills || { total: 0 };
    if (!d.total) { card.style.display = "none"; return; }
    card.style.display = "block";
    const acc = Math.round(d.correct / d.total * 100);
    const covered = (d.done || []).length;
    el.innerHTML = `
      <div class="stat-row" style="margin:0">
        <div class="card stat-card" style="margin:0"><div class="stat-value">${d.total}</div><div class="stat-label">푼 문제</div></div>
        <div class="card stat-card" style="margin:0"><div class="stat-value">${acc}%</div><div class="stat-label">정답률</div></div>
        <div class="card stat-card" style="margin:0"><div class="stat-value">${covered}/${allDrills().length}</div><div class="stat-label">경험한 문제</div></div>
      </div>
      <p class="muted small" style="margin-top:10px">${acc >= 80
        ? "안목이 잘 잡혔어요. 이제 내 글에 적용하는 게 관건입니다."
        : acc >= 60 ? "절반 이상 맞히고 있어요. 해설의 '원리'를 소리 내어 읽어보세요."
        : "지금은 감으로 고르는 단계예요. 틀린 문제의 원리를 다시 읽으면 빠르게 올라갑니다."}</p>`;
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
    renderPracticeLog();
    const el = $("#log-list");
    const list = [...state.sessions].reverse();
    if (!list.length) { el.innerHTML = `<p class="empty-msg">아직 데일리 세션 기록이 없어요. 오늘 탭에서 첫 세션을 시작해 보세요!</p>`; return; }
    el.innerHTML = list.map((s, idx) => {
      const tbMap = { speak: "tb-speak", review: "tb-review", quality: "tb-quality", write: "tb-write" };
      const tb = tbMap[s.track] || "tb-write";
      const tn = s.lessonId === "diagnostic" ? "진단" : (TRACK_NAMES[s.track] || "구조");
      const revs = (s.revisions || []).map(r => `\n【${r.pass}차 수정${r.focus && dimOf(r.focus) ? ` · ${dimOf(r.focus).label}` : ""}】\n${r.text}`).join("");
      const qs = s.qualityScores ? `\n📊 품질: ${QUALITY_DIMS.map(d => `${d.label} ${s.qualityScores[d.key] || "-"}`).join(" / ")}` : "";
      const qsf = s.qualityScoresFinal ? `\n📈 최종본: ${QUALITY_DIMS.map(d => `${d.label} ${s.qualityScoresFinal[d.key] || "-"}`).join(" / ")}` : "";
      const body = [
        s.topic ? `🎤 주제: ${s.topic}` : "",
        s.submission ? `【초고】\n${s.submission}` : "",
        s.noticed ? `\n【스스로 발견】\n${s.noticed}` : "",
        revs || (s.retry ? `\n【수정】\n${s.retry}` : ""),
        qs, qsf,
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

  function renderPracticeLog() {
    const card = $("#practice-log-card"), el = $("#practice-log");
    if (!card || !el) return;
    if (!state.practices.length) { card.style.display = "none"; return; }
    card.style.display = "block";
    el.innerHTML = [...state.practices].reverse().map((p, idx) => {
      const cat = PRACTICE_CATS.find(c => c.key === p.cat);
      const body = [
        `【내가 한 말】\n${p.response}`,
        p.tipsCount ? `\n핵심 포인트 ${p.checkedCount}/${p.tipsCount} 반영` : "",
        p.aiFeedback ? `\n\n🤖 AI 피드백\n${p.aiFeedback}` : ""
      ].filter(Boolean).join("");
      return `
      <div class="log-item" data-p="${idx}">
        <div class="lh">
          <span class="lday">${cat ? cat.emoji : "🎤"} ${esc(p.title)}</span>
          <span><span class="track-badge ${p.type === "talk" ? "tb-speak" : "tb-write"}">${p.type === "talk" ? "발표" : "대화"}</span> <span class="ldate">${esc(p.date || "")}</span></span>
        </div>
        <div class="lbody">${esc(body)}</div>
      </div>`;
    }).join("");
    $$(".log-item", el).forEach(it => it.addEventListener("click", () => it.classList.toggle("open")));
  }

  /* ============================ 설정 탭 ============================ */
  let uiProvider = "gemini";
  function refreshProviderUI() {
    const p = $("#set-provider").value;
    const sel = $("#set-model");
    sel.innerHTML = AI_MODELS[p].map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("");
    const cfg = state.settings[p] || {};
    sel.value = cfg.model || AI_MODELS[p][0][0];
    const key = $("#set-apikey");
    key.value = cfg.key || "";
    key.placeholder = KEY_PLACEHOLDER[p];
    $("#key-help").textContent = KEY_HELP[p];
  }
  function persistForm(p) {
    const cfg = state.settings[p] || (state.settings[p] = {});
    cfg.key = $("#set-apikey").value.trim();
    cfg.model = $("#set-model").value;
  }
  /* 실행 중인 sw.js의 CACHE 버전 문자열을 읽어와 보여준다.
     "no-store"로 받아야 이 요청 자체가 오래된 캐시를 보여주는 일이 없다. */
  async function loadAppVersion() {
    const el = $("#app-version");
    if (!el) return;
    try {
      const res = await fetch("sw.js", { cache: "no-store" });
      const txt = await res.text();
      const m = txt.match(/CACHE\s*=\s*"([^"]+)"/);
      el.textContent = m ? m[1] : "확인 불가";
    } catch (e) {
      el.textContent = "확인 불가(오프라인)";
    }
  }
  function renderSettings() {
    loadAppVersion();
    uiProvider = state.settings.provider || "gemini";
    $("#set-provider").value = uiProvider;
    refreshProviderUI();
    $("#set-ai-enabled").checked = !!state.settings.aiEnabled;
    $("#set-ai-saver").checked = !!state.settings.aiSaver;
    $("#set-autogen").checked = !!state.settings.autoGenDrills;
    $("#set-daily-budget").value = state.settings.dailyBudget || 40;
    renderUsageBar();
  }
  function renderUsageBar() {
    const u = aiUsageStatus();
    $("#usage-bar-fill").style.width = u.pct + "%";
    $("#usage-bar-fill").className = "usage-bar-fill usage-" + u.level;
    $("#usage-bar-text").textContent = u.level === "over"
      ? `오늘 ${u.count}회 사용 · 정해둔 목표(${u.budget}회)를 넘었어요`
      : `오늘 ${u.count} / ${u.budget}회 사용 · ${u.remain}회 남음`;
  }
  function wireSettingsOnce() {
    const fu = $("#force-update");
    if (fu) fu.addEventListener("click", async () => {
      setStatus("#update-status", "캐시를 지우고 최신 버전을 받아오는 중…", "");
      try {
        if ("caches" in window) {
          const names = await caches.keys();
          await Promise.all(names.map((n) => caches.delete(n)));
        }
        if ("serviceWorker" in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister()));
        }
        setStatus("#update-status", "다 지웠어요. 새로고침합니다…", "ok");
        // 쿼리스트링을 바꿔서 브라우저 자체 HTTP 캐시도 확실히 건너뛴다
        setTimeout(() => { location.href = location.pathname + "?fresh=" + Date.now(); }, 500);
      } catch (e) {
        setStatus("#update-status", "업데이트 실패: " + e.message + " — 홈 화면 아이콘을 지웠다 다시 추가해보세요.", "err");
      }
    });
    $("#set-provider").addEventListener("change", () => {
      persistForm(uiProvider);            // 떠나는 제공자에 현재 입력 보존
      uiProvider = $("#set-provider").value;
      refreshProviderUI();
    });
    $("#save-settings").addEventListener("click", () => {
      persistForm(uiProvider);
      state.settings.provider = uiProvider;
      state.settings.aiEnabled = $("#set-ai-enabled").checked;
      state.settings.aiSaver = $("#set-ai-saver").checked;
      state.settings.autoGenDrills = $("#set-autogen").checked;
      const budget = parseInt($("#set-daily-budget").value, 10);
      state.settings.dailyBudget = budget > 0 ? budget : 40;
      save();
      renderUsageBar();
      updateHeaderUsage();
      setStatus("#ai-status", "저장했어요.", "ok");
    });
    $("#test-ai").addEventListener("click", testAI);
    $("#edit-goals").addEventListener("click", () => {
      const g = prompt("어떤 글이나 말을 잘하고 싶나요?\n(자세히 적을수록 커리큘럼이 정확해집니다)", state.goals || "");
      if (g === null) return;
      const next = g.trim();
      const changed = next !== (state.goals || "");
      state.goals = next;
      if (changed) state.planStale = true;   // 목표가 바뀌면 계획을 다시 짜야 한다
      save(); renderProgress();
      if (changed && aiReady()) {
        if (confirm("목표가 바뀌었어요. 새 목표에 맞춰 커리큘럼을 다시 계획할까요? (AI 호출 1회)")) {
          replanFromGoal("#goal-status");
        } else {
          setStatus("#goal-status", "계획은 그대로예요. 나중에 ‘다시 계획’을 눌러도 됩니다.", "");
        }
      } else if (changed) {
        setStatus("#goal-status", "목표를 저장했어요. AI 키를 넣으면 이 목표에 맞춰 커리큘럼을 다시 짤 수 있어요.", "");
      }
    });
    $("#replan-goal").addEventListener("click", () => {
      if (!aiReady()) { setStatus("#goal-status", "설정에서 AI를 켜고 키를 넣어주세요.", "err"); return; }
      if (!state.goals) { setStatus("#goal-status", "먼저 목표를 적어주세요.", "err"); return; }
      replanFromGoal("#goal-status");
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
  const SYSTEM_PROMPT = `당신은 한국어 글쓰기·말하기 전담 코치입니다. 언어학·교육심리학·수사학의 검증된 이론에
근거해 피드백합니다. 형식적인 덕담이 아니라, 학습자가 다음 문장을 실제로 다르게 쓰게 만드는 피드백을 씁니다.

## 피드백 설계 원리
- 형성평가(Hattie & Timperley): 반드시 세 질문에 답한다 — 목표는 무엇인가(Feed Up) /
  지금 어디에 있는가(Feed Back) / 다음에 무엇을 할 것인가(Feed Forward).
- 인지부하 관리(Sweller): 오늘의 목표 기술 하나에만 집중한다. 다른 결점은 보여도 언급하지 않는다.
- 주목 가설(Schmidt): 답을 바로 주기 전에, 학습자가 스스로 차이를 알아차리게 하는 질문을 먼저 던진다.
- 성장 마인드셋(Dweck): 칭찬은 재능이 아니라 학습자가 실제로 취한 전략과 노력에 대해서만 한다.
- ZPD(Vygotsky): 지금 혼자 된 것과, 조금만 도우면 될 것을 구분해서 다음 과제를 지정한다.

## 반드시 지킬 것
- 학습자 글의 실제 표현을 그대로 인용해 근거로 삼는다. 일반론("문장을 다듬으세요")은 금지.
- 개선점은 최대 2가지. 각 개선점에는 왜 문제인지의 언어학적 이유를 한 줄 붙인다.
- 문장 수술은 학습자의 문장을 골라 '전 → 후'로 보여주되, 글 전체를 대신 고쳐 쓰지는 않는다.
- 진단 근거 없는 칭찬, 인사말, 사족 금지.

## 출력 형식 (아래 라벨을 그대로 쓰고, 각 항목은 1~3문장)
[목표]
오늘 이 과제로 도달하려는 상태를 한 문장으로.
[현재]
학습자의 글이 지금 어디에 있는지. 반드시 실제 인용을 근거로.
[잘한 점]
전략·노력에 대한 구체적 칭찬. 어느 표현이 왜 효과적인지.
[개선 1]
문제 → 왜 문제인지(이론·독자 반응) → 어떻게 고칠지.
[개선 2]
(있으면. 없으면 이 항목 생략)
[문장 수술]
전) 학습자의 원문 한 문장
후) 고친 예 한 문장
왜) 무엇이 달라졌는지 한 줄
[스스로 찾기]
학습자가 직접 알아차리도록 던지는 질문 1~2개.
[다음 단계]
당장 실행할 구체적 행동 하나. (예: "재도전에서 3번째 문장만 20자 이내로 줄여보세요")

한국어. 전체 700~900자. 따뜻하지만 정확하게.`;

  function buildUserMessage(L, text, phase) {
    const m = metrics(text);
    return `[오늘의 목표 기술] ${L.skill} (${L.category})
[목표] ${L.goal}
[이 기술의 이론적 근거] ${L.why}
[과제] ${L.task}
[제약] ${(L.constraints || []).join(" / ")}
[코치가 준 개선 힌트] ${(L.hints || []).join(" / ")}
${phase === "retry" ? "[이것은 재도전 제출입니다. 이전보다 나아진 지점을 먼저 확인하고, 남은 한 가지만 짚어주세요.]\n" : ""}
[기계 분석 참고치 — 그대로 나열하지 말고 판단 근거로만]
글자 ${m.chars} / 문장 ${m.sentences} / 평균 ${m.mean}자(편차 ${m.sd}) / 길이 ${m.lens.join(",")}
군더더기후보 ${m.fillers} / 완충표현 ${m.hedges} / 피동 ${m.passives} / 접속사 ${m.connectors}
이어붙임 ${m.conjTails} / 감정어 ${m.emotionWords} / 감각어 ${m.senses} / 동일종결어미연속 ${m.sameEnding}

[학습자 제출]
${text}

오늘 기술(${L.skill})에만 집중해, 지정된 출력 형식으로 피드백하세요.`;
  }

  /* 라벨 구획을 파싱해 카드로 렌더 (모델이 형식을 안 지켜도 원문 그대로 표시) */
  const FB_STYLE = {
    "목표": ["fb-goal", "🎯 목표"],
    "현재": ["fb-now", "📍 지금 어디에"],
    "잘한 점": ["fb-praise", "👏 잘한 점"],
    "개선 1": ["fb-improve", "🔧 개선 1"],
    "개선 2": ["fb-improve", "🔧 개선 2"],
    "문장 수술": ["fb-surgery", "✂️ 문장 수술"],
    "스스로 찾기": ["fb-notice", "🔎 스스로 찾기"],
    "다음 단계": ["fb-next", "➡️ 다음 단계"]
  };
  function renderAIFeedback(raw) {
    const text = String(raw || "").trim();
    if (!text) return "";
    const re = /\[([^\]\n]{1,12})\]\s*([\s\S]*?)(?=\n\s*\[[^\]\n]{1,12}\]|$)/g;
    let out = "", found = false, mm;
    while ((mm = re.exec(text)) !== null) {
      const label = mm[1].trim(), body = mm[2].trim();
      if (!body) continue;
      const sty = FB_STYLE[label];
      if (!sty) continue;
      found = true;
      const inner = label === "문장 수술" ? renderSurgery(body) : esc(body).replace(/\n/g, "<br>");
      out += `<div class="fb-block ${sty[0]}"><span class="fb-h">${sty[1]}</span>${inner}</div>`;
    }
    return found ? out : `<div class="ai-answer">${esc(text)}</div>`;
  }
  function renderSurgery(body) {
    const lines = body.split("\n").map(s => s.trim()).filter(Boolean);
    let html = "";
    lines.forEach(line => {
      const m1 = line.match(/^전\)\s*(.*)$/), m2 = line.match(/^후\)\s*(.*)$/), m3 = line.match(/^왜\)\s*(.*)$/);
      if (m1) html += `<div class="sg before"><span class="sg-tag">전</span>${esc(m1[1])}</div>`;
      else if (m2) html += `<div class="sg after"><span class="sg-tag">후</span>${esc(m2[1])}</div>`;
      else if (m3) html += `<div class="sg why">→ ${esc(m3[1])}</div>`;
      else html += `<div class="sg why">${esc(line)}</div>`;
    });
    return html;
  }

  /* ---- 제공자 공통 헬퍼 ---- */
  const AI_MODELS = {
    gemini: [
      ["gemini-2.5-flash", "Gemini 2.5 Flash (권장 · 무료)"],
      ["gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite (가장 빠름 · 무료)"],
      ["gemini-2.0-flash", "Gemini 2.0 Flash (무료)"]
    ],
    anthropic: [
      ["claude-sonnet-5", "Claude Sonnet 5 (유료)"],
      ["claude-opus-4-8", "Claude Opus 4.8 (유료)"],
      ["claude-haiku-4-5-20251001", "Claude Haiku 4.5 (유료)"]
    ]
  };
  const KEY_HELP = {
    gemini: "무료 키 발급 → Google AI Studio (aistudio.google.com/apikey) 접속 후 “Create API key”. 신용카드 없이 발급됩니다.",
    anthropic: "키 발급 → console.anthropic.com (사용량에 따라 과금)"
  };
  const KEY_PLACEHOLDER = { gemini: "AIza…", anthropic: "sk-ant-…" };

  function aiCfg() { return state.settings[state.settings.provider] || {}; }
  function currentKey() { return (aiCfg().key || "").trim(); }
  function currentModel() { return aiCfg().model; }
  function aiReady() { return !!(state.settings.aiEnabled && currentKey()); }

  /* AI 호출 1회 = 1건으로 집계 (오늘 몇 번 썼는지 설정에서 확인 가능) */
  function countAIUsage() {
    const t = todayStr();
    if (state.aiUsage.date !== t) state.aiUsage = { date: t, count: 0 };
    state.aiUsage.count += 1;
    save();
    updateHeaderUsage();
  }
  function todayAIUsage() {
    return state.aiUsage.date === todayStr() ? state.aiUsage.count : 0;
  }
  /* 하루 목표 호출 수 대비 잔여량. 실제 API 한도가 아니라 사용자가 정한 안전선이므로
     넘어도 호출을 막지는 않고, 얼마나 남았는지만 알려준다. */
  function aiUsageStatus() {
    const count = todayAIUsage();
    const budget = state.settings.dailyBudget || 40;
    const pct = Math.min(100, Math.round((count / budget) * 100));
    const remain = Math.max(0, budget - count);
    const level = count >= budget ? "over" : pct >= 80 ? "warn" : "ok";
    return { count, budget, remain, pct, level };
  }
  function usageGaugeHTML() {
    const u = aiUsageStatus();
    const icon = u.level === "over" ? "🔴" : u.level === "warn" ? "🟡" : "🟢";
    const msg = u.level === "over"
      ? `오늘 목표(${u.budget}회)를 넘었어요 · ${u.count}회 사용`
      : `오늘 ${u.count}/${u.budget}회 · ${u.remain}회 남음`;
    return `<span class="usage-gauge usage-${u.level}" title="${esc(msg)}">${icon} ${u.count}/${u.budget}</span>`;
  }

  /* wantJSON=true 면 Gemini를 JSON 전용 출력 모드로 돌려 형식 붕괴를 크게 줄인다 */
  function callAI(system, userMsg, maxTokens, wantJSON) {
    countAIUsage();
    return state.settings.provider === "anthropic"
      ? callAnthropic(system, userMsg, maxTokens)
      : callGemini(system, userMsg, maxTokens, wantJSON);
  }

  /* 출력이 토큰 상한에 걸려 중간에 잘리면(finishReason MAX_TOKENS) JSON이 깨진다.
     복구를 시도하기 전에, 예산을 늘려 한 번 자동 재시도한다 — 근본 원인을 없애는 편이
     사후 복구보다 안전하다. */
  async function callGemini(system, userMsg, maxTokens, wantJSON, _retried) {
    const model = currentModel() || "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(currentKey())}`;
    const budget = maxTokens || 1600;
    const genCfg = { maxOutputTokens: budget, temperature: 0.7 };
    if (wantJSON) { genCfg.responseMimeType = "application/json"; genCfg.temperature = 0.4; }
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: userMsg }] }],
        generationConfig: genCfg
      })
    });
    if (!res.ok) {
      let detail = ""; try { detail = (await res.json()).error?.message || ""; } catch (e) {}
      throw new Error(`${res.status} ${detail || "요청 실패"}`);
    }
    const data = await res.json();
    const cand = data.candidates && data.candidates[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    const text = parts.map(p => p.text || "").join("").trim();
    if (cand && cand.finishReason === "MAX_TOKENS" && !_retried && budget < 7500) {
      return callGemini(system, userMsg, Math.min(budget * 2, 8000), wantJSON, true);
    }
    if (!text) throw new Error(data.promptFeedback ? "안전 필터로 응답이 차단됐어요" : "빈 응답");
    return text;
  }

  async function callAnthropic(system, userMsg, maxTokens) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": currentKey(),
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: currentModel() || "claude-sonnet-5",
        max_tokens: maxTokens || 1600,
        system: system,
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
    if (slot) slot.innerHTML = `<span class="spinner"></span>AI 코치가 분석하고 있어요…`;
    try {
      const out = await callAI(SYSTEM_PROMPT, buildUserMessage(L, text, phase));
      if (phase === "retry") sess.aiRetryFeedback = out; else sess.aiFeedback = out;
      save();
      if (slot) slot.innerHTML = renderAIFeedback(out);
    } catch (e) {
      if (slot) slot.innerHTML = `<span style="color:var(--danger)">AI 피드백 실패: ${esc(e.message)}. 설정에서 키/모델을 확인하세요. (위 오프라인 관찰은 그대로 유효합니다.)</span>
        <button class="btn ghost small" id="ai-retry-btn">다시 시도</button>`;
      const rb = $("#ai-retry-btn");
      if (rb) rb.addEventListener("click", () => requestAIFeedback(sess, L, text, phase));
    }
  }

  async function testAI() {
    persistForm(uiProvider);
    state.settings.provider = uiProvider;
    if (!currentKey()) { setStatus("#ai-status", "먼저 API 키를 입력하세요.", "err"); return; }
    setStatus("#ai-status", "연결 테스트 중…", "");
    try {
      const out = await callAI("당신은 테스트 도우미입니다.", "한 단어로 '연결됨'이라고만 답하세요.");
      setStatus("#ai-status", "연결 성공 ✓ — " + out.slice(0, 40), "ok");
    } catch (e) {
      setStatus("#ai-status", "연결 실패: " + e.message, "err");
    }
  }

  /* ============================ 유틸 ============================ */
  /* 제약에서 '전체 글'의 글자수 상한만 골라낸다.
     '그중 하나는 6자 이하의 짧은 문장'처럼 문장·단어 단위 조건을 전체 상한으로
     오인하면 카운터가 6자로 잡히는 문제가 있었다. */
  function extractCharLimit(constraints) {
    let best = 0;
    for (const c of (constraints || [])) {
      const s = String(c);
      if (/문장|단어|어절|제목|각\s/.test(s)) continue;   // 부분 단위 조건은 제외
      const m = s.match(/(\d+)\s*자\s*(이내|이하)/);
      if (!m) continue;
      const v = parseInt(m[1], 10);
      if (v < 50) continue;                               // 전체 글 상한으로 보기엔 너무 작음
      best = best ? Math.min(best, v) : v;                // 여러 개면 가장 엄격한 값
    }
    return best;
  }

  /* ============================ 실전 말하기 ============================ */
  let practiceCat = "all";
  const sitById = (id) => SITUATIONS.find(s => s.id === id);

  let practiceMode = "situations";   // 'situations' | 'roleplay' | 'study' | 'drills'
  /* 안목(drills)은 글쓰기 계열, 나머지 셋은 말하기 계열 — 상단 글쓰기·말하기 스위치에 맞춰 걸러낸다.
     '균형' 프리셋일 때만 전부 보여준다. */
  const SEGMENT_DEFS = [
    { key: "train", label: "🏋️ 훈련", mode: "both" },
    { key: "situations", label: "🎤 상황", mode: "speak" },
    { key: "roleplay", label: "💬 롤플레이", mode: "speak" },
    { key: "study", label: "🔬 썰해부", mode: "speak" },
    { key: "drills", label: "👁️ 안목", mode: "write" }
  ];
  function availableSegments() {
    const m = currentMode();
    return SEGMENT_DEFS.filter(s => s.mode === "both" || m === "both" || s.mode === m);
  }
  function segmentHTML() {
    const d = state.drills || { total: 0 };
    const rp = (state.roleplayLog || []).length;
    const sd = (state.studyDone || []).length;
    const tset = trainSet();
    const tLeft = tset.items.length - tset.solved.length;
    const badge = { situations: "", roleplay: rp ? `<span class="seg-n">${rp}</span>` : "",
      train: tLeft ? `<span class="seg-n">${tLeft}</span>` : "",
      study: sd ? `<span class="seg-n">${sd}</span>` : "", drills: d.total ? `<span class="seg-n">${d.total}</span>` : "" };
    const segs = availableSegments();
    if (segs.length <= 1) return "";   // 하나뿐이면 고를 게 없으니 전환 UI를 안 보여준다
    return `<div class="seg-row">${segs.map(s =>
      `<button class="seg ${practiceMode === s.key ? "active" : ""}" data-mode="${s.key}">${s.label}${badge[s.key] || ""}</button>`
    ).join("")}</div>`;
  }
  function renderPractice() {
    const root = $("#practice-root");
    if (!root) return;
    const ap = state.activePractice;
    if (ap) {
      const sit = sitById(ap.sid);
      root.innerHTML = ap.stage === "feedback" ? viewPracticeFeedback(ap, sit) : viewPracticeWrite(ap, sit);
      ap.stage === "feedback" ? wirePracticeFeedback(ap, sit) : wirePracticeWrite(ap, sit);
      return;
    }
    // 현재 모드에서 안 보이는 세그먼트에 남아 있었으면 이 모드의 첫 번째 세그먼트로 옮긴다
    const segs = availableSegments().map(s => s.key);
    if (!segs.includes(practiceMode)) practiceMode = segs[0] || "situations";
    if (practiceMode === "train") {
      root.innerHTML = segmentHTML() + viewTrain();
      wireSegments(); wireTrain();
    } else if (practiceMode === "study") {
      root.innerHTML = segmentHTML() + viewStudy();
      wireSegments(); wireStudy();
    } else if (practiceMode === "roleplay") {
      root.innerHTML = segmentHTML() + viewRoleplay();
      wireSegments(); wireRoleplay();
    } else if (practiceMode === "drills") {
      root.innerHTML = segmentHTML() + viewDrill();
      wireSegments(); wireDrill();
      maybeAutoGenerateDrills();
    } else {
      root.innerHTML = segmentHTML() + viewPracticeBrowse();
      wireSegments(); wirePracticeBrowse();
    }
  }
  function wireSegments() {
    $$(".seg").forEach(s => s.addEventListener("click", () => {
      practiceMode = s.getAttribute("data-mode"); renderPractice(); window.scrollTo(0, 0);
    }));
  }

  /* ==================== 매일 훈련 (API 0원) ====================
   * 하루 한 편의 긴 과제만으로는 개별 기술을 충분히 반복하지 못한다.
   * 좁은 기술을 짧게 여러 번 반복하고 즉시 교정하는 층을 따로 둔다.
   * 틀린 문항은 간격을 두고 다시 나온다(Roediger & Karpicke: 인출 + 분산). */
  const TRAIN_SET_SIZE = 12;
  const TRAIN_INTERVALS = [1, 3, 7, 16, 35];   // 연속 정답 횟수별 재출제 간격(일)

  function trainLog(id) {
    state.train.log = state.train.log || {};
    return state.train.log[id] || { seen: 0, streak: 0, lastDay: -999 };
  }
  /* 이 문항을 오늘 다시 내야 하는가 — 연속 정답이 쌓일수록 간격이 늘어난다 */
  function trainDue(id) {
    const lg = trainLog(id);
    if (!lg.seen) return true;                       // 아직 안 본 문항
    const gap = TRAIN_INTERVALS[Math.min(lg.streak, TRAIN_INTERVALS.length - 1)];
    return (dayIndex() - lg.lastDay) >= gap;
  }
  function dayIndex() { return Math.floor(Date.now() / 86400000); }

  function trainPool() {
    const m = currentMode();
    return TRAIN_ITEMS.filter(it => m === "both" || it.mode === m);
  }
  /* 오늘의 세트 — 복습 대상(틀렸던 것) 먼저, 그다음 새 문항.
     기술이 한쪽으로 쏠리지 않게 같은 기술은 최대 2문항까지만 담는다. */
  function buildTrainSet() {
    const pool = trainPool();
    const due = pool.filter(it => trainDue(it.id));
    const rank = (it) => {
      const lg = trainLog(it.id);
      if (lg.seen && lg.streak === 0) return 0;      // 틀린 적 있음 — 최우선 복습
      if (!lg.seen) return 1;                        // 새 문항
      return 2;                                      // 간격 도래한 복습
    };
    const seed = hashStr(todayStr());
    const sorted = due.slice().sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r) return r;
      return (hashStr(a.id + seed) % 1000) - (hashStr(b.id + seed) % 1000);
    });
    const out = [], perSkill = {};
    for (const it of sorted) {
      if (out.length >= TRAIN_SET_SIZE) break;
      if ((perSkill[it.skill] || 0) >= 2) continue;
      perSkill[it.skill] = (perSkill[it.skill] || 0) + 1;
      out.push(it);
    }
    // 간격 제한 때문에 부족하면 나머지로 채운다(연습량이 우선)
    if (out.length < TRAIN_SET_SIZE) {
      for (const it of pool) {
        if (out.length >= TRAIN_SET_SIZE) break;
        if (out.indexOf(it) < 0) out.push(it);
      }
    }
    return out;
  }
  function trainSet() {
    const t = todayStr();
    const d = state.train.daily;
    const byId = {}; TRAIN_ITEMS.forEach(it => { byId[it.id] = it; });
    if (d && d.date === t && d.ids && d.ids.length) {
      const items = d.ids.map(id => byId[id]).filter(Boolean);
      if (items.length) return { items: items, solved: d.solved || [] };
    }
    const set = buildTrainSet();
    state.train.daily = { date: t, ids: set.map(i => i.id), solved: [] };
    save();
    return { items: set, solved: [] };
  }

  /* 채점 — mcq/order는 정오답이 분명하고, rewrite/fill은 규칙 통과 여부로 본다 */
  function gradeRewrite(item, text) {
    const t = String(text || "");
    return item.checks.map(c => {
      // 원본 정규식에 g 플래그가 있으면 test()가 상태를 갖게 되므로 매번 새로 만든다
      const re = new RegExp(c.re.source, c.re.flags.replace("g", ""));
      const hit = re.test(t);
      return { label: c.label, ok: c.need ? hit : !hit, need: c.need };
    });
  }
  function trainRecord(item, correct) {
    state.train.log = state.train.log || {};
    const lg = trainLog(item.id);
    state.train.log[item.id] = {
      seen: lg.seen + 1,
      streak: correct ? lg.streak + 1 : 0,
      lastDay: dayIndex()
    };
    state.train.total = (state.train.total || 0) + 1;
    if (correct) {
      state.train.correct = (state.train.correct || 0) + 1;
      state.train.xp = (state.train.xp || 0) + 10;
    } else {
      state.train.xp = (state.train.xp || 0) + 3;   // 틀려도 시도에 보상 — 회피를 막는다
    }
    const d = state.train.daily;
    if (d && d.solved.indexOf(item.id) < 0) d.solved.push(item.id);
    if (state.trainLastDate !== todayStr()) { state.trainLastDate = todayStr(); recordActivity(); }
    save();
  }

  /* 진행 중인 문항의 화면 상태 (저장하지 않음 — 한 문항은 짧게 끝난다) */
  let trainCur = null;   // { item, picked, order[], text, slots{}, graded, correct }
  function trainNext() {
    const set = trainSet();
    const left = set.items.filter(i => set.solved.indexOf(i.id) < 0);
    const item = left[0] || null;
    trainCur = item ? { item: item, picked: null, order: [], text: "", slots: {}, graded: false, correct: false } : null;
  }

  function viewTrain() {
    const set = trainSet();
    const doneN = set.solved.length, totalN = set.items.length;
    const xp = state.train.xp || 0;
    const acc = state.train.total ? Math.round(state.train.correct / state.train.total * 100) : 0;
    const head = `
      <div class="card" style="padding:14px 16px">
        <h2 style="margin-bottom:6px">🏋️ 매일 훈련 <span class="sub">하루 ${TRAIN_SET_SIZE}문항 · 5분</span></h2>
        <p class="practice-intro">긴 과제 하나보다, 좁은 기술을 짧게 여러 번 반복할 때 실력이 빨리 붙습니다.
        틀린 문항은 며칠 뒤에 다시 나옵니다.
        <span class="muted" style="font-size:12px">· AI 호출 없음 · ⚡${xp} XP${state.train.total ? ` · 정답률 ${acc}%` : ""}</span></p>
        <div class="daily-bar">
          <div class="daily-head">
            <span>📅 오늘의 훈련 <b>${doneN}/${totalN}</b></span>
            <span class="muted">${currentMode() === "write" ? "✍️ 글쓰기" : currentMode() === "speak" ? "🎙️ 말하기" : "균형"} 모드</span>
          </div>
          <div class="daily-track"><span class="daily-fill" style="width:${totalN ? doneN / totalN * 100 : 0}%"></span></div>
        </div>
      </div>`;
    // 방금 채점한 문항은 해설을 먼저 보여준다. (채점 즉시 solved에 들어가므로
    // 이 분기가 없으면 정답 해설을 못 보고 다음 문항으로 건너뛴다)
    if (trainCur && trainCur.graded) return head + viewTrainItem(trainCur);
    if (doneN >= totalN && totalN > 0) {
      return head + `
        <div class="card" style="text-align:center; padding:26px 18px">
          <div style="font-size:40px">🎉</div>
          <h2 style="margin:8px 0 4px">오늘의 훈련 완료!</h2>
          <p class="muted small">${totalN}문항을 모두 풀었어요. 내일 새 세트가 나옵니다.</p>
          <button class="btn ghost small" id="train-more" style="margin-top:12px">그래도 더 풀기</button>
        </div>`;
    }
    if (!trainCur || set.solved.indexOf(trainCur.item.id) >= 0) trainNext();
    if (!trainCur) return head + `<div class="card"><p class="empty-msg">훈련할 문항이 없어요.</p></div>`;
    return head + viewTrainItem(trainCur);
  }

  function viewTrainItem(cur) {
    const it = cur.item, sk = TRAIN_SKILLS[it.skill] || { label: it.skill, emoji: "•" };
    const tag = `<div class="train-tag">${sk.emoji} ${esc(sk.label)}</div>`;
    const ctx = it.context ? `<div class="train-ctx">${esc(it.context)}</div>` : "";
    const after = cur.graded ? `
      <div class="fb-block ${cur.correct ? "fb-praise" : "fb-improve"}">
        <span class="fb-h">${cur.correct ? "✅ 정확합니다" : "🔍 이렇게 보세요"}</span>${esc(it.why)}</div>
      ${it.tip ? `<div class="recall-line">📌 ${esc(it.tip)}</div>` : ""}
      <button class="btn primary" id="train-next">다음 문항</button>` : "";

    if (it.type === "mcq") {
      const opts = it.options.map((o, i) => {
        let cls = "";
        if (cur.graded) cls = i === it.answer ? "correct" : (cur.picked === i ? "wrong" : "dim");
        else if (cur.picked === i) cls = "picked";
        return `<button class="train-opt ${cls}" data-i="${i}" ${cur.graded ? "disabled" : ""}>${esc(o)}</button>`;
      }).join("");
      return `<div class="card">${tag}${ctx}
        <div class="train-q">${esc(it.prompt)}</div>
        <div class="train-opts">${opts}</div>
        ${!cur.graded ? `<button class="btn primary" id="train-check" ${cur.picked === null ? "disabled" : ""}>확인</button>` : after}
      </div>`;
    }

    if (it.type === "order") {
      const chosen = cur.order.map((li, pos) =>
        `<div class="train-ord-row"><span class="ord-n">${pos + 1}</span>${esc(it.lines[li])}
          ${!cur.graded ? `<button class="ord-x" data-pos="${pos}">✕</button>` : ""}</div>`).join("");
      const rest = it.lines.map((l, i) => cur.order.indexOf(i) >= 0 ? "" :
        `<button class="train-ord-pick" data-i="${i}">${esc(l)}</button>`).join("");
      const right = cur.graded ? `<div class="section-label">정답 순서</div>
        <div class="train-ord-answer">${it.answer.map((li, p) =>
          `<div class="train-ord-row"><span class="ord-n">${p + 1}</span>${esc(it.lines[li])}</div>`).join("")}</div>` : "";
      return `<div class="card">${tag}${ctx}
        <div class="train-q">${esc(it.prompt)}</div>
        <div class="section-label">순서대로 눌러 배열하세요</div>
        <div class="train-ord-chosen">${chosen || `<p class="muted small">아래에서 첫 문장을 고르세요.</p>`}</div>
        <div class="train-ord-rest">${rest}</div>
        ${right}
        ${!cur.graded ? `<button class="btn primary" id="train-check" ${cur.order.length !== it.lines.length ? "disabled" : ""}>확인</button>` : after}
      </div>`;
    }

    if (it.type === "rewrite") {
      const marks = cur.graded ? gradeRewrite(it, cur.text) : [];
      return `<div class="card">${tag}${ctx}
        <div class="train-q">${esc(it.ask)}</div>
        <div class="train-before"><span class="tb-h">고칠 문장</span>${esc(it.before)}</div>
        ${!cur.graded ? `
          <textarea id="train-text" rows="4" placeholder="직접 고쳐 써보세요.">${esc(cur.text)}</textarea>
          <button class="btn primary" id="train-check">확인</button>
        ` : `
          <div class="train-mine"><span class="tb-h">내가 쓴 것</span>${esc(cur.text)}</div>
          <div class="check-list">${marks.map(m =>
            `<div class="check-row ${m.ok ? "ok" : "no"}"><span>${m.ok ? "✓" : "✗"}</span>${esc(m.label)}</div>`).join("")}</div>
          <div class="train-model"><span class="tb-h">참고 답안</span>${esc(it.model)}</div>
          ${after}
        `}
      </div>`;
    }

    // fill
    const slots = it.slots.map(s => {
      if (cur.graded) {
        const v = (cur.slots[s.key] || "").trim();
        const ok = charLen(v) >= (s.min || 5);
        return `<div class="fill-slot">
          <div class="fs-label">${esc(s.label)} <span class="${ok ? "sv-ok" : "sv-warn"}">${ok ? "✓" : "너무 짧아요"}</span></div>
          <div class="fs-mine">${esc(v || "(비어 있음)")}</div>
          <div class="fs-model">참고: ${esc(it.model[s.key] || "")}</div>
        </div>`;
      }
      return `<div class="fill-slot">
        <div class="fs-label">${esc(s.label)}</div>
        ${s.hint ? `<div class="fs-hint">${esc(s.hint)}</div>` : ""}
        <textarea class="fill-in" data-k="${s.key}" rows="2" placeholder="${esc(s.hint || "")}">${esc(cur.slots[s.key] || "")}</textarea>
      </div>`;
    }).join("");
    return `<div class="card">${tag}
      <div class="train-q">${esc(it.topic)}</div>
      ${slots}
      ${!cur.graded ? `<button class="btn primary" id="train-check">확인</button>` : after}
    </div>`;
  }

  function wireTrain() {
    const more = $("#train-more");
    if (more) more.addEventListener("click", () => {
      // 오늘 세트를 다 풀었어도 더 하고 싶으면 새 세트를 뽑아준다
      state.train.daily = null; save(); trainCur = null; renderPractice(); window.scrollTo(0, 0);
    });
    if (!trainCur) return;
    const cur = trainCur, it = cur.item;

    $$(".train-opt").forEach(b => b.addEventListener("click", () => {
      if (cur.graded) return;
      cur.picked = parseInt(b.getAttribute("data-i"), 10);
      renderPractice();
    }));
    $$(".train-ord-pick").forEach(b => b.addEventListener("click", () => {
      if (cur.graded) return;
      cur.order.push(parseInt(b.getAttribute("data-i"), 10));
      renderPractice();
    }));
    $$(".ord-x").forEach(b => b.addEventListener("click", () => {
      if (cur.graded) return;
      cur.order.splice(parseInt(b.getAttribute("data-pos"), 10), 1);
      renderPractice();
    }));
    const ta = $("#train-text");
    if (ta) ta.addEventListener("input", () => { cur.text = ta.value; });
    $$(".fill-in").forEach(t => t.addEventListener("input", () => {
      cur.slots[t.getAttribute("data-k")] = t.value;
    }));

    const chk = $("#train-check");
    if (chk) chk.addEventListener("click", () => {
      if (it.type === "mcq") {
        if (cur.picked === null) return;
        cur.correct = cur.picked === it.answer;
      } else if (it.type === "order") {
        if (cur.order.length !== it.lines.length) return;
        cur.correct = cur.order.join(",") === it.answer.join(",");
      } else if (it.type === "rewrite") {
        if (charLen(cur.text) < 5) { alert("조금 더 써보세요."); return; }
        cur.correct = gradeRewrite(it, cur.text).every(m => m.ok);
      } else {
        const short = it.slots.filter(s => charLen((cur.slots[s.key] || "").trim()) < (s.min || 5));
        if (short.length) { alert(`아직 덜 채운 칸이 있어요: ${short.map(s => s.label).join(", ")}`); return; }
        cur.correct = true;   // 틀 채우기는 정오답이 아니라 '해봤는가'가 핵심
      }
      cur.graded = true;
      trainRecord(it, cur.correct);
      renderPractice();
    });
    const nx = $("#train-next");
    if (nx) nx.addEventListener("click", () => { trainNext(); renderPractice(); window.scrollTo(0, 0); });
  }

  /* ==================== 썰 해부 (API 0원) ====================
   * 같은 사건의 밋밋한 버전과 재밌는 버전을 나란히 놓고, 무엇이 달라졌는지
   * 먼저 스스로 찾게 한다(주목 가설). 안목이 먼저 서야 내 썰도 고칠 수 있다. */
  /* 썰 해부 — 예전엔 '고르고 정답 확인'(인식)이었는데, 인식만으로는 자기 썰이 안 는다.
     이제는 밋밋한 원본을 직접 다시 써보고(생산), 그다음에야 예시와 로컬 스캔으로 비교한다.
     Ericsson의 요점: 실력은 알아보는 것이 아니라 만들어보고 즉시 되짚을 때 는다. */
  let studyIdx = 0, studyRevealed = false, studyDraft = "";
  function viewStudy() {
    const p = STORY_PAIRS[studyIdx % STORY_PAIRS.length];
    const done = (state.studyDone || []).length;
    const header = `
      <div class="card" style="padding:14px 16px">
        <h2 style="margin-bottom:6px">🔬 썰 리라이트 훈련 <span class="sub">직접 다시 써보기</span></h2>
        <p class="practice-intro">밋밋한 사건을 <b>당신이 먼저 재밌게 다시 써보세요.</b>
        쓰고 나면 실제 재밌는 버전과 바로 비교해서, 뭘 더 넣으면 좋을지 확인합니다.
        읽고 알아보는 것과 직접 써보는 것은 다른 훈련입니다 — 실력은 쓸 때 늡니다.
        <span class="muted" style="font-size:12px">· AI 호출 없음 · ${done}/${STORY_PAIRS.length}편 연습</span></p>
      </div>`;
    if (!studyRevealed) {
      return header + `
      <div class="card">
        <div class="study-title">📌 ${esc(p.title)}</div>
        <div class="study-ver flat">
          <div class="sv-head">😐 밋밋한 버전 (원본)</div>
          <div class="sv-body">${esc(p.flat)}</div>
        </div>
        <div class="section-label">이 사건, 당신이라면 어떻게 재밌게 풀까요?</div>
        <textarea id="study-rewrite" rows="6" placeholder="직접 다시 써보세요. 대사·현재형·쉼(...)·확대 표지를 써보면 좋아요.">${esc(studyDraft)}</textarea>
        <div class="char-count" id="study-count">${charLen(studyDraft)}자</div>
        <button class="btn primary" id="study-submit">비교하기</button>
      </div>`;
    }
    const sc = localStoryScan(studyDraft);
    const tagChips = p.tags.map(t => {
      const d = STORY_DIMS.find(x => x.key === t);
      return d ? `<span class="tag-chip">${d.emoji} ${esc(d.label)}</span>` : "";
    }).join("");
    return header + `
      <div class="card">
        <div class="study-title">📌 ${esc(p.title)}</div>
        <div class="study-ver flat">
          <div class="sv-head">😐 원본</div>
          <div class="sv-body">${esc(p.flat)}</div>
        </div>
        <div class="study-ver mine">
          <div class="sv-head">✍️ 내가 쓴 버전</div>
          <div class="sv-body">${esc(studyDraft)}</div>
        </div>
        <div class="section-label">내 버전 장치 점검 (기계 분석)</div>
        ${storyScanHTML(sc)}
        <div class="study-ver good">
          <div class="sv-head">😂 재밌는 버전 (예시)</div>
          <div class="sv-body">${esc(p.good)}</div>
        </div>
        <div class="section-label">이 예시가 쓴 장치</div>
        <div class="study-answer">${tagChips}</div>
        <div class="fb-block fb-now"><span class="fb-h">왜 달라졌나</span>${esc(p.why)}</div>
        <div class="fb-block fb-next"><span class="fb-h">기억할 원칙</span>${esc(p.lesson)}</div>
        <button class="btn primary" id="study-next">다음 편</button>
      </div>`;
  }
  function wireStudy() {
    const ta = $("#study-rewrite");
    if (ta) ta.addEventListener("input", () => {
      studyDraft = ta.value;
      const cc = $("#study-count"); if (cc) cc.textContent = charLen(ta.value) + "자";
    });
    const sub = $("#study-submit");
    if (sub) sub.addEventListener("click", () => {
      if (charLen(studyDraft) < 20) { alert("조금 더 써보세요. 20자는 넘어야 비교할 수 있어요."); return; }
      studyRevealed = true;
      const p = STORY_PAIRS[studyIdx % STORY_PAIRS.length];
      state.studyDone = state.studyDone || [];
      if (state.studyDone.indexOf(p.id) < 0) state.studyDone.push(p.id);
      if (state.studyLastDate !== todayStr()) { state.studyLastDate = todayStr(); recordActivity(); }
      save(); renderPractice();
    });
    const nx = $("#study-next");
    if (nx) nx.addEventListener("click", () => {
      studyIdx++; studyRevealed = false; studyDraft = "";
      renderPractice(); window.scrollTo(0, 0);
    });
  }

  /* ==================== 롤플레이 UI ==================== */
  const MOOD_UI = {
    open: ["😊", "mood-open", "마음을 열고 있어요"],
    neutral: ["🙂", "mood-neutral", "무난하게 듣고 있어요"],
    closing: ["😐", "mood-closing", "대화가 식어가요"]
  };
  function viewRoleplay() {
    const rp = state.roleplay;
    if (!rp) {
      const cards = ROLEPLAY_SCENES.map(s => {
        const done = (state.roleplayLog || []).filter(l => l.sceneId === s.id).length;
        return `<div class="rp-card" data-scene="${s.id}">
          <div class="rp-emoji">${s.emoji}</div>
          <div class="rp-main">
            <div class="rp-title">${esc(s.label)} ${done ? `<span class="rp-done">${done}회</span>` : ""}</div>
            <div class="rp-goal">${esc(s.goal)}</div>
          </div>
          <div class="rp-diff" title="난이도">${"●".repeat(s.difficulty)}<span class="dim">${"○".repeat(5 - s.difficulty)}</span></div>
        </div>`;
      }).join("");
      return `
        <div class="card" style="padding:14px 16px">
          <h2 style="margin-bottom:6px">💬 롤플레이 <span class="sub">실제 대화 연습</span></h2>
          <p class="practice-intro">AI가 <b>코치가 아니라 상대</b>가 되어 실제처럼 반응합니다.
          잘 받아주면 마음을 열고, 어색하면 대화가 식습니다. 사회적 말하기는 혼자 연습할 수 없는데,
          여기서는 가능합니다.
          ${aiReady() ? `<span class="muted" style="font-size:12px">· 턴마다 호출 1회</span>`
            : `<br><span class="muted" style="font-size:12px">⚠️ 설정에서 무료 Gemini 키를 넣어야 대화할 수 있어요.</span>`}</p>
        </div>
        <div>${cards}</div>`;
    }
    const scene = ROLEPLAY_SCENES.find(s => s.id === rp.sceneId);
    if (!scene) { state.roleplay = null; save(); return viewRoleplay(); }
    if (rp.stage === "review") return viewRoleplayReview(rp, scene);
    const mood = MOOD_UI[rp.mood] || MOOD_UI.neutral;
    const bubbles = rp.history.map(h => h.role === "user"
      ? `<div class="bub me">${esc(h.text)}</div>`
      : `<div class="bub them"><span class="bub-who">${scene.emoji} ${esc(scene.label)}</span>${esc(h.text)}</div>`).join("");
    const turns = rp.history.filter(h => h.role === "user").length;
    return `
      <button class="sit-back" id="rp-quit">← 롤플레이 목록</button>
      <div class="card rp-head-card">
        <div class="rp-head-row">
          <div><b>${scene.emoji} ${esc(scene.label)}</b>
            <div class="muted small">${esc(scene.goal)}</div></div>
          <div class="mood-chip ${mood[1]}" title="${esc(mood[2])}">${mood[0]} ${esc(mood[2])}</div>
        </div>
        <div class="rp-turns">턴 ${turns} · ${esc(scene.tips.join(" / "))}</div>
      </div>
      <div class="chat-wrap" id="chat-wrap">${bubbles}
        <div id="rp-typing"></div>
      </div>
      <div class="card" style="padding:12px">
        <textarea id="rp-input" rows="3" placeholder="뭐라고 말할까요? 실제로 소리 내어 말해본 뒤 적으세요."></textarea>
        <button class="btn primary" id="rp-send">보내기</button>
        <button class="btn ghost small" id="rp-end">대화 끝내고 복기</button>
        <p id="rp-status" class="notify-status"></p>
      </div>`;
  }
  function viewRoleplayReview(rp, scene) {
    const rev = rp.review;
    const bubbles = rp.history.map(h => h.role === "user"
      ? `<div class="bub me">${esc(h.text)}</div>`
      : `<div class="bub them"><span class="bub-who">${scene.emoji}</span>${esc(h.text)}</div>`).join("");
    const notes = rp.history.filter(h => h.coach).map((h, i) =>
      `<div class="coach-note"><span class="cn-n">${i + 1}</span>${esc(h.coach)}</div>`).join("");
    const body = rev ? `
      ${rev.oneLine ? `<div class="fb-block fb-now"><span class="fb-h">🗣️ 총평</span>${esc(rev.oneLine)}</div>` : ""}
      ${rev.flow ? `<div class="fb-block fb-now"><span class="fb-h">🌊 대화의 흐름</span>${esc(rev.flow)}</div>` : ""}
      ${renderSpeechReport({ scores: rev.scores, principle: rev.principle, nextAction: rev.nextAction }, SOCIAL_DIMS)}
      ${rev.best ? `<div class="fb-block fb-praise"><span class="fb-h">👏 가장 좋았던 말</span>
        <div class="quote-line">“${esc(rev.best.quote || "")}”</div>${esc(rev.best.why || "")}</div>` : ""}
      ${rev.miss ? `<div class="fb-block fb-surgery"><span class="fb-h">✂️ 아쉬웠던 말</span>
        <div class="sg before"><span class="sg-tag">전</span>${esc(rev.miss.quote || "")}</div>
        <div class="sg after"><span class="sg-tag">후</span>${esc(rev.miss.better || "")}</div>
        <div class="sg why">→ ${esc(rev.miss.why || "")}</div></div>` : ""}
    ` : `<div id="rp-review-slot"><span class="spinner"></span>대화를 복기하는 중…</div>`;
    return `
      <button class="sit-back" id="rp-quit">← 롤플레이 목록</button>
      <div class="card">
        <h2>💬 ${scene.emoji} ${esc(scene.label)} — 복기</h2>
        <div class="chat-wrap review">${bubbles}</div>
      </div>
      <div class="card">${body}</div>
      ${notes ? `<div class="card"><h2>🔍 턴별 코치 관찰</h2>
        <p class="muted small">대화 중에는 숨겨져 있던 관찰입니다.</p>${notes}</div>` : ""}
      <button class="btn primary" id="rp-again">다시 연습하기</button>`;
  }
  function wireRoleplay() {
    const back = $("#rp-quit");
    if (back) back.addEventListener("click", () => { state.roleplay = null; save(); renderPractice(); });
    $$(".rp-card").forEach(c => c.addEventListener("click", () => {
      if (!aiReady()) { alert("롤플레이는 AI 상대가 필요해요. 설정에서 무료 Gemini 키를 넣어주세요."); return; }
      const scene = ROLEPLAY_SCENES.find(s => s.id === c.getAttribute("data-scene"));
      state.roleplay = {
        sceneId: scene.id, stage: "chat", mood: "neutral",
        history: [{ role: "them", text: scene.opening }], review: null
      };
      save(); renderPractice(); window.scrollTo(0, 0);
    }));
    const send = $("#rp-send");
    if (send) send.addEventListener("click", roleplaySend);
    const inp = $("#rp-input");
    if (inp) inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) roleplaySend();
    });
    const end = $("#rp-end");
    if (end) end.addEventListener("click", roleplayEnd);
    const again = $("#rp-again");
    if (again) again.addEventListener("click", () => {
      const sid = state.roleplay && state.roleplay.sceneId;
      const scene = ROLEPLAY_SCENES.find(s => s.id === sid);
      state.roleplay = scene ? { sceneId: sid, stage: "chat", mood: "neutral",
        history: [{ role: "them", text: scene.opening }], review: null } : null;
      save(); renderPractice(); window.scrollTo(0, 0);
    });
    const wrap = $("#chat-wrap");
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
    if (state.roleplay && state.roleplay.stage === "review" && !state.roleplay.review) roleplayReview();
  }
  let _rpBusy = false;
  async function roleplaySend() {
    if (_rpBusy) return;
    const inp = $("#rp-input");
    const text = (inp.value || "").trim();
    if (charLen(text) < 2) { setStatus("#rp-status", "뭐라도 말해보세요.", "err"); return; }
    const rp = state.roleplay;
    const scene = ROLEPLAY_SCENES.find(s => s.id === rp.sceneId);
    _rpBusy = true;
    rp.history.push({ role: "user", text: text });
    inp.value = "";
    save(); renderPractice();
    const typing = $("#rp-typing");
    if (typing) typing.innerHTML = `<div class="bub them typing"><span class="spinner"></span>…</div>`;
    try {
      const hist = rp.history.slice(0, -1);
      const raw = await callAI(ROLEPLAY_SYSTEM, roleplayUserMessage(scene, hist, text), 700);
      const p = parseRoleplay(raw);
      // 코치 관찰은 '학습자가 방금 한 말'에 대한 평가이므로 직전 user 턴에만 붙인다.
      // (상대 turn에도 붙이면 복기 화면에서 같은 문장이 두 번 나온다)
      for (let i = rp.history.length - 1; i >= 0; i--) {
        if (rp.history[i].role === "user") { rp.history[i].coach = p.coach; break; }
      }
      rp.history.push({ role: "them", text: p.say });
      rp.mood = MOOD_UI[p.mood] ? p.mood : "neutral";
      save(); renderPractice();
    } catch (e) {
      setStatus("#rp-status", "응답 실패: " + e.message, "err");
      const t2 = $("#rp-typing"); if (t2) t2.innerHTML = "";
    } finally { _rpBusy = false; }
  }
  function roleplayEnd() {
    const rp = state.roleplay;
    const turns = rp.history.filter(h => h.role === "user").length;
    if (!turns) { setStatus("#rp-status", "한 마디라도 나눠보고 끝내세요.", "err"); return; }
    rp.stage = "review"; save(); renderPractice(); window.scrollTo(0, 0);
  }
  async function roleplayReview() {
    const rp = state.roleplay;
    const scene = ROLEPLAY_SCENES.find(s => s.id === rp.sceneId);
    const lines = rp.history.map(h => `${h.role === "user" ? "학습자" : scene.label}: ${h.text}`).join("\n");
    const msg = `[상황] ${scene.label} — ${scene.persona}
[학습자의 목표] ${scene.goal}

[대화 전문]
${lines}

이 대화 전체를 총평하고 JSON만 출력하세요.`;
    try {
      const raw = await callAI(ROLEPLAY_REVIEW_SYSTEM, msg, 3200, true);
      const j = extractJSON(raw);
      rp.review = j;
      state.roleplayLog = state.roleplayLog || [];
      state.roleplayLog.push({
        date: todayStr(), sceneId: scene.id, label: scene.label,
        turns: rp.history.filter(h => h.role === "user").length,
        scores: j.scores || null, oneLine: j.oneLine || ""
      });
      if (j.scores) recordSpeech(j, { day: state.currentDay, lessonId: "rp-" + scene.id, track: "social", take: 0 });
      // 하루 한 번만 활동으로 집계
      if (state.roleplayLastDate !== todayStr()) { state.roleplayLastDate = todayStr(); recordActivity(); }
      save(); renderPractice();
    } catch (e) {
      const s = $("#rp-review-slot");
      if (s) s.innerHTML = `<span style="color:var(--danger)">복기 실패: ${esc(e.message)}</span>
        <button class="btn ghost small" id="rp-rev-retry">다시 시도</button>`;
      const rb = $("#rp-rev-retry");
      if (rb) rb.addEventListener("click", roleplayReview);
    }
  }

  /* ==================== A/B 안목 훈련 (API 0원) ====================
   * 절대 채점보다 비교 판단이 정확하다는 평가 연구에 기반.
   * 먼저 고르게 하고(주목), 그다음 원리를 보여준다.
   * ============================================================== */
  let drillState = null;   // { drill, picked, revealed }
  let drillFilter = "all";

  /* 문자열 → 안정적 해시 (FNV-1a). 확산이 좋아 시드를 섞으면 순서가 충분히 흔들린다.
     h*31 방식은 앞 글자가 값을 지배해, 날짜를 섞어도 순서가 거의 그대로였다. */
  function hashStr(s) {
    const str = String(s);
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h ^ (h >>> 16)) >>> 0;
  }
  /* 해설의 A/B 라벨을 서로 바꿔치기 (데이터는 'b가 정답' 형태로 저술됨) */
  function swapABLabels(t) {
    return String(t || "").replace(/([AB])([는은의가를와도])/g, (m, l, p) => (l === "A" ? "B" : "A") + p);
  }
  /* 정답이 한쪽에 몰리지 않게 문제별로 좌우를 결정적으로 뒤집는다.
     (전부 B가 정답이면 학습자가 '무조건 B'를 학습해 훈련이 무의미해진다) */
  function balanceDrill(d) {
    if (hashStr(d.id) % 2 === 0) return d;
    return Object.assign({}, d, {
      a: d.b, b: d.a,
      better: d.better === "a" ? "b" : "a",
      why: swapABLabels(d.why)
    });
  }
  const BASE_DRILLS = AB_DRILLS
    .concat(typeof DRILLS_EXTRA !== "undefined" ? DRILLS_EXTRA : [])
    .map(balanceDrill);

  /* 저작 문제 + AI가 생성해 저장한 문제 */
  function allDrills() {
    const gen = (state.drills && state.drills.generated) || [];
    return BASE_DRILLS.concat(gen.map(balanceDrill));
  }
  function drillPool() {
    return allDrills().filter(d => drillFilter === "all" || d.dim === drillFilter);
  }

  /* ---- 오늘의 세트 ----
   * 날짜를 시드로 매일 다른 문제를 배치한다. 틀린 문제는 3일 뒤 다시 나온다(간격 반복). */
  const DAILY_SET_SIZE = 12;
  function dailySeed() {
    return hashStr(todayStr());
  }
  function dueForReview(id) {
    const w = (state.drills.wrong || {})[id];
    if (!w) return false;
    const days = Math.floor((Date.now() - w.at) / 86400000);
    return days >= 3;
  }
  function buildDailySet() {
    const pool = drillPool();
    const done = state.drills.done || [];
    const seed = dailySeed();
    // ① 복습 대상(틀린 지 3일 지남) → ② 안 풀어본 문제 → ③ 나머지
    const review = pool.filter(d => dueForReview(d.id));
    const fresh = pool.filter(d => done.indexOf(d.id) < 0 && !dueForReview(d.id));
    const rest = pool.filter(d => done.indexOf(d.id) >= 0 && !dueForReview(d.id));
    const order = (arr, salt) => [...arr].sort((x, y) =>
      (hashStr(x.id + seed + salt) % 9973) - (hashStr(y.id + seed + salt) % 9973));
    const picked = order(review, "r").slice(0, 4)
      .concat(order(fresh, "f"))
      .concat(order(rest, "x"));
    // 세 집합은 서로 겹치지 않아야 하지만, 데이터에 우연히 같은 id가 둘 있는 경우까지
    // 대비해 한 번 더 걸러낸다(방어적 중복 제거).
    const seen = new Set(), dedup = [];
    for (const d of picked) { if (!seen.has(d.id)) { seen.add(d.id); dedup.push(d); } }
    return dedup.slice(0, DAILY_SET_SIZE);
  }
  function todaySet() {
    const t = todayStr();
    const ds = state.drills.daily;
    if (ds && ds.date === t && ds.ids && ds.ids.length) {
      const map = {};
      allDrills().forEach(d => { map[d.id] = d; });
      const items = ds.ids.map(id => map[id]).filter(Boolean);
      if (items.length) return { items: items, solved: ds.solved || [] };
    }
    const set = buildDailySet();
    state.drills.daily = { date: t, ids: set.map(d => d.id), solved: [] };
    save();
    return { items: set, solved: [] };
  }
  /* 오늘의 세트를 다 풀면 자유 연습(무작위)으로 넘어가는데, 순수 무작위 추첨은
     방금 본 문제가 바로 다음에 또 뽑힐 수 있다(카테고리 필터로 문제 수가 적을수록
     체감 확률이 높아짐). 직전 문제는 후보에서 제외해 연속 중복을 막는다. */
  let _lastDrillId = null;
  function nextDrill() {
    const set = todaySet();
    const unsolved = set.items.filter(d => set.solved.indexOf(d.id) < 0);
    let picked;
    if (unsolved.length) {
      picked = unsolved[0];
    } else {
      const pool = drillPool();
      const candidates = pool.filter(d => d.id !== _lastDrillId);
      const src = candidates.length ? candidates : pool;
      picked = src[Math.floor(Math.random() * src.length)] || null;
    }
    if (picked) _lastDrillId = picked.id;
    return picked;
  }
  function viewDrill() {
    const d = state.drills || { done: [], correct: 0, total: 0 };
    const pool = allDrills();
    const chips = [{ key: "all", label: "전체", emoji: "✨" }].concat(QUALITY_DIMS.map(x => ({ key: x.key, label: x.label, emoji: x.emoji })))
      .map(c => {
        const n = c.key === "all" ? pool.length : pool.filter(x => x.dim === c.key).length;
        return `<button class="cat-chip ${drillFilter === c.key ? "active" : ""}" data-dim="${c.key}">${c.emoji} ${esc(c.label)}<span class="n">${n}</span></button>`;
      }).join("");
    const set = todaySet();
    const solvedN = set.solved.length, setN = set.items.length;
    const setDone = solvedN >= setN && setN > 0;
    if (!drillState) drillState = { drill: nextDrill(), picked: null, revealed: false };
    const dr = drillState.drill;
    const acc = d.total ? Math.round(d.correct / d.total * 100) : 0;
    const genN = ((state.drills || {}).generated || []).length;
    const header = `
      <div class="card" style="padding:14px 16px">
        <h2 style="margin-bottom:6px">👁️ 안목 훈련 <span class="sub">A/B 비교</span></h2>
        <p class="practice-intro">둘 중 <b>어느 쪽이 더 좋은지 먼저 고르고</b>, 그다음 이유를 확인하세요.
        규칙을 외우기보다 차이를 알아차리는 것이 실력이 됩니다.</p>
        <div class="daily-bar">
          <div class="daily-head">
            <span>📅 오늘의 세트 <b>${solvedN}/${setN}</b></span>
            <span class="muted">문제 ${pool.length}개${genN ? ` (AI 생성 ${genN})` : ""} · 정답률 ${d.total ? acc + "%" : "–"}</span>
          </div>
          <div class="daily-track"><span class="daily-fill" style="width:${setN ? solvedN / setN * 100 : 0}%"></span></div>
          ${setDone ? `<div class="daily-done">✅ 오늘의 세트 완료! 이제부터는 자유 연습이에요.</div>` : ""}
        </div>
        ${drillGenHTML()}
        <div class="cat-scroll">${chips}</div>
      </div>`;
    if (!dr) return header + `<div class="card"><p class="empty-msg">이 분야의 문제가 없어요.</p></div>`;
    const dim = dimOf(dr.dim);
    const picked = drillState.picked, revealed = drillState.revealed;
    const optCls = (k) => {
      if (!revealed) return picked === k ? "picked" : "";
      if (k === dr.better) return "correct";
      return picked === k ? "wrong" : "dim";
    };
    return header + `
      <div class="card">
        <div class="drill-dim">${dim ? `${dim.emoji} ${esc(dim.label)}` : ""} · ${esc(dim ? dim.short : "")}
          ${dr.ai ? `<span class="gen-badge">AI 생성</span>` : ""}</div>
        <div class="drill-q">${esc(dr.q)}</div>
        <button class="drill-opt ${optCls("a")}" data-pick="a" ${revealed ? "disabled" : ""}>
          <span class="drill-tag">A</span><span class="drill-text">${esc(dr.a)}</span>
        </button>
        <button class="drill-opt ${optCls("b")}" data-pick="b" ${revealed ? "disabled" : ""}>
          <span class="drill-tag">B</span><span class="drill-text">${esc(dr.b)}</span>
        </button>
        ${revealed ? `
          <div class="drill-result ${picked === dr.better ? "ok" : "no"}">
            ${picked === dr.better ? "✅ 맞았어요" : `❌ 아쉬워요 — 정답은 ${dr.better.toUpperCase()}`}
          </div>
          <div class="fb-block fb-now"><span class="fb-h">왜 그런가</span>${esc(dr.why)}</div>
          <div class="fb-block fb-next"><span class="fb-h">기억할 원리</span>${esc(dr.principle)}</div>
          <button class="btn primary" id="drill-next">다음 문제</button>
          ${dr.ai ? `<button class="btn ghost small danger" id="drill-del">이 문제 삭제</button>` : ""}
        ` : `<p class="muted small" style="margin-top:12px">고르면 해설이 나옵니다.</p>`}
      </div>`;
  }

  /* AI 문제 생성 안내 · 버튼 */
  function drillGenHTML() {
    if (!aiReady()) {
      return `<p class="muted" style="font-size:12px; margin-top:2px">💡 설정에서 무료 Gemini 키를 넣으면
        매일 <b>내 약점 축에 맞춘 새 문제</b>가 자동으로 추가돼요(하루 1회 호출).</p>`;
    }
    const g = state.drills.gen || {};
    const generatedToday = g.date === todayStr();
    const weak = weakestQualityDim();
    const wd = weak ? dimOf(weak) : null;
    return `
      <div class="gen-row">
        <span class="gen-text">${generatedToday
          ? `✨ 오늘 새 문제 <b>${g.count || 0}개</b>를 추가했어요.`
          : `✨ 새 문제 만들기 ${wd ? `<span class="muted">(약점: ${wd.emoji} ${esc(wd.label)})</span>` : ""}`}</span>
        <button class="btn ghost small" id="gen-drills" style="margin:0">${generatedToday ? "더 만들기" : "생성 (호출 1회)"}</button>
      </div>
      <p id="gen-status" class="notify-status" style="min-height:0"></p>`;
  }
  function wireDrill() {
    $$(".cat-chip").forEach(c => c.addEventListener("click", () => {
      drillFilter = c.getAttribute("data-dim");
      drillState = null; renderPractice();
    }));
    $$(".drill-opt").forEach(b => b.addEventListener("click", () => {
      if (drillState.revealed) return;
      const pick = b.getAttribute("data-pick");
      drillState.picked = pick;
      drillState.revealed = true;
      const dr = drillState.drill;
      const right = pick === dr.better;
      state.drills.total = (state.drills.total || 0) + 1;
      if (right) state.drills.correct = (state.drills.correct || 0) + 1;
      state.drills.done = state.drills.done || [];
      if (state.drills.done.indexOf(dr.id) < 0) state.drills.done.push(dr.id);
      // 틀린 문제는 3일 뒤 오늘의 세트에 다시 넣는다(간격 반복)
      state.drills.wrong = state.drills.wrong || {};
      if (right) delete state.drills.wrong[dr.id];
      else state.drills.wrong[dr.id] = { at: Date.now() };
      // 오늘의 세트 진행도
      const ds = state.drills.daily;
      if (ds && ds.date === todayStr() && ds.ids.indexOf(dr.id) >= 0) {
        ds.solved = ds.solved || [];
        if (ds.solved.indexOf(dr.id) < 0) ds.solved.push(dr.id);
      }
      // 활동 기록은 하루 한 번만 (문제마다 세면 잔디밭·스트릭이 부풀어 오른다)
      if (state.drills.lastDate !== todayStr()) {
        state.drills.lastDate = todayStr();
        recordActivity();
      }
      save();
      renderPractice();
    }));
    const nx = $("#drill-next");
    if (nx) nx.addEventListener("click", () => {
      drillState = { drill: nextDrill(), picked: null, revealed: false };
      renderPractice(); window.scrollTo(0, 0);
    });
    const del = $("#drill-del");
    if (del) del.addEventListener("click", () => {
      const id = drillState.drill.id;
      state.drills.generated = (state.drills.generated || []).filter(x => x.id !== id);
      const ds = state.drills.daily;
      if (ds) ds.ids = (ds.ids || []).filter(x => x !== id);
      save();
      drillState = { drill: nextDrill(), picked: null, revealed: false };
      renderPractice();
    });
    const gen = $("#gen-drills");
    if (gen) gen.addEventListener("click", () => generateDrills(true));
  }

  /* ---- AI 문제 생성 ----
   * 약점 축을 겨냥해 새 A/B 문제를 만들고, 구조 검증을 통과한 것만 저장한다.
   * 하루 1회 자동(설정) + 버튼으로 수동. 생성분은 기기에 영구 보관된다. */
  const DRILL_GEN_SYSTEM = `당신은 한국어 글쓰기 교육용 A/B 비교 문제를 만드는 출제자입니다.
학습자는 두 문장(또는 짧은 문단) 중 어느 쪽이 더 좋은지 고르고 해설을 읽으며 '안목'을 기릅니다.

## 문제의 질을 결정하는 조건 (반드시 지킬 것)
1. 두 보기는 **같은 내용**을 다루되, 지정된 품질 축 하나에서만 분명하게 차이 나야 합니다.
   다른 축의 차이(오탈자·길이만의 차이 등)를 섞지 마세요.
2. 정답이 **명확**해야 합니다. 전문가 열 명이 보면 열 명이 같은 답을 골라야 합니다.
   애매하면 그 문제를 버리고 다른 문제를 만드세요.
3. 나쁜 보기는 **실제로 학습자가 쓸 만한 문장**이어야 합니다. 일부러 우스꽝스럽게 만들지 마세요.
4. 좋은 보기도 **과장되지 않은 자연스러운 한국어**여야 합니다.
5. 소재는 한국인의 일상·직장·학교 맥락에서 고르고, 매 문제마다 다른 소재를 쓰세요.
6. 해설(why)은 두 보기를 A/B로 지칭해 차이를 설명하고, 왜 그것이 독자에게 문제인지 밝히세요.
   **항상 B가 더 좋은 보기가 되도록** 배치하세요(앱이 좌우를 자동으로 섞습니다).
7. principle은 외워서 쓸 수 있는 한 문장 원칙으로, 특정 소재에 얽매이지 않게 쓰세요.

## 아래 JSON만 출력 (코드블록·설명·인사말 금지)
{"drills":[
  {"dim":"축 key","q":"질문 (예: 어느 쪽이 더 구체적인가요?)","a":"덜 좋은 보기","b":"더 좋은 보기",
   "why":"A는 ... B는 ... 형태로 차이와 그 이유를 2~3문장","principle":"기억할 원칙 한 문장"}
]}

## JSON 형식 주의 (반드시)
- 값 안에 큰따옴표(")를 쓰지 마세요. 인용이 필요하면 홑따옴표(')나 그냥 따옴표 없이 쓰세요.
- 값 안에서 줄바꿈하지 마세요.
- 마지막 항목 뒤에 콤마를 붙이지 마세요.`;

  function drillGenUserMessage(dim, n) {
    const d = dimOf(dim);
    const examples = BASE_DRILLS.filter(x => x.dim === dim).slice(0, 2)
      .map(x => `- 질문: ${x.q}\n  나쁜 보기: ${x.better === "a" ? x.b : x.a}\n  좋은 보기: ${x.better === "a" ? x.a : x.b}\n  원칙: ${x.principle}`).join("\n");
    const usedQ = allDrills().filter(x => x.dim === dim).map(x => x.q);
    return `[겨냥할 품질 축] ${d ? `${d.key} — ${d.label}: ${d.detail}` : dim}
[이 축에서 흔한 실패] ${d ? d.bad : ""}
[이론 배경] ${d ? d.theory : ""}

[기존 문제 예시 — 형식과 난이도의 기준. 내용은 절대 반복하지 말 것]
${examples}

[이미 출제된 질문들 — 겹치지 않게]
${usedQ.join(" / ")}

${state.goals ? `[학습자 목표] ${state.goals}\n` : ""}이 축의 새 문제 ${n}개를 위 조건에 맞춰 JSON으로 출제하세요. 소재를 서로 다르게 하세요.`;
  }

  /* 구조 검증 — 애매하거나 형식이 깨진 문제를 걸러낸다 */
  function validateGenDrill(d) {
    if (!d || typeof d !== "object") return null;
    const dim = String(d.dim || "").trim();
    if (!dimOf(dim)) return null;
    const q = String(d.q || "").trim();
    const a = String(d.a || "").trim();
    const b = String(d.b || "").trim();
    const why = String(d.why || "").trim();
    const principle = String(d.principle || "").trim();
    if (!q || !a || !b || !why || !principle) return null;
    if (a === b) return null;
    if (a.length < 6 || b.length < 6) return null;
    if (a.length > 400 || b.length > 400) return null;
    if (why.length < 20) return null;
    // 해설이 두 보기를 구분해 설명하는지 (A/B 라벨 사용 확인)
    if (!/A[는은의가를와도]/.test(why) || !/B[는은의가를와도]/.test(why)) return null;
    // 보기 내용이 겹치면 버린다. (발문 q는 축마다 자연스럽게 반복되므로 검사하지 않는다)
    const dup = allDrills().some(x => x.a === a || x.b === b || x.a === b || x.b === a);
    if (dup) return null;
    return {
      id: "gx-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
      dim: dim, q: q, a: a, b: b, better: "b", why: why, principle: principle, ai: true
    };
  }

  let _genRunning = false;
  async function generateDrills(manual) {
    if (_genRunning || !aiReady()) return 0;
    _genRunning = true;
    const st = $("#gen-status");
    if (st) { st.textContent = "새 문제를 만들고 있어요…"; st.className = "notify-status"; }
    // 약점 축 우선, 없으면 가장 문제 수가 적은 축
    let dim = weakestQualityDim();
    if (!dim) {
      const counts = QUALITY_DIMS.map(d => ({ key: d.key, n: allDrills().filter(x => x.dim === d.key).length }));
      counts.sort((x, y) => x.n - y.n);
      dim = counts[0].key;
    }
    let added = 0;
    try {
      const raw = await callAI(DRILL_GEN_SYSTEM, drillGenUserMessage(dim, 8), 3584, true);
      const j = extractJSON(raw);
      const list = Array.isArray(j.drills) ? j.drills : [];
      state.drills.generated = state.drills.generated || [];
      list.forEach(item => {
        const v = validateGenDrill(item);
        if (v) { state.drills.generated.push(v); added++; }
      });
      const t = todayStr();
      const g = state.drills.gen || {};
      state.drills.gen = { date: t, count: (g.date === t ? (g.count || 0) : 0) + added };
      // 새 문제가 생겼으니 오늘의 세트에 섞어 넣는다
      if (added && state.drills.daily && state.drills.daily.date === t) {
        const fresh = state.drills.generated.slice(-added).map(x => x.id);
        state.drills.daily.ids = state.drills.daily.ids.concat(fresh).slice(0, DAILY_SET_SIZE + added);
      }
      save();
      if (st) {
        st.textContent = added
          ? `새 문제 ${added}개를 추가했어요. (검증 통과 ${added}/${list.length})`
          : "쓸 만한 문제가 나오지 않아 저장하지 않았어요. 다시 시도해보세요.";
        st.className = "notify-status " + (added ? "ok" : "err");
      }
      if (added && manual) renderPractice();
    } catch (e) {
      if (st) { st.textContent = "생성 실패: " + e.message; st.className = "notify-status err"; }
    }
    _genRunning = false;
    return added;
  }

  /* 하루 1회 자동 생성 — 안목 훈련 탭을 처음 열 때 조용히 돈다 */
  function maybeAutoGenerateDrills() {
    if (!aiReady() || !state.settings.autoGenDrills) return;
    const g = state.drills.gen || {};
    if (g.date === todayStr()) return;
    generateDrills(false).then(n => { if (n) renderPractice(); });
  }

  function viewPracticeBrowse() {
    const cats = [{ key: "all", label: "전체", emoji: "✨" }].concat(PRACTICE_CATS);
    const chips = cats.map(c => {
      const n = c.key === "all" ? SITUATIONS.length : SITUATIONS.filter(s => s.cat === c.key).length;
      return `<button class="cat-chip ${practiceCat === c.key ? "active" : ""}" data-cat="${c.key}">${c.emoji} ${esc(c.label)}<span class="n">${n}</span></button>`;
    }).join("");
    /* 목표에 맞는 카테고리를 추천 (진단·재계획에서 받은 recommendCats) */
    const rec = (state.recommendCats || []).filter(k => PRACTICE_CATS.find(c => c.key === k));
    const recCard = (rec.length && practiceCat === "all") ? `
      <div class="rec-box">
        <div class="rec-head">🧭 내 목표에 맞는 상황</div>
        <div class="rec-chips">${rec.map(k => {
          const c = PRACTICE_CATS.find(x => x.key === k);
          const n = SITUATIONS.filter(s => s.cat === k).length;
          return `<button class="cat-chip rec" data-cat="${k}">${c.emoji} ${esc(c.label)}<span class="n">${n}</span></button>`;
        }).join("")}</div>
      </div>` : "";
    const list = SITUATIONS.filter(s => practiceCat === "all" || s.cat === practiceCat);
    const cards = list.map(s => {
      const cat = PRACTICE_CATS.find(c => c.key === s.cat);
      const done = state.practices.some(p => p.sid === s.id);
      return `
      <div class="sit-card" data-sid="${s.id}">
        <div class="sit-emoji ${s.type === "talk" ? "speak" : ""}">${cat ? cat.emoji : "🎤"}</div>
        <div class="sit-main">
          <div class="sit-title">${esc(s.title)} ${done ? "✅" : ""}</div>
          <div class="sit-scene">${esc(s.scene)}</div>
        </div>
        <span class="sit-type ${s.type === "talk" ? "type-talk" : "type-reply"}">${s.type === "talk" ? "발표" : "대화"}</span>
      </div>`;
    }).join("");
    const doneCount = state.practices.length;
    return `
      <div class="card" style="padding:14px 16px">
        <h2 style="margin-bottom:6px">🎤 실전 상황별 말하기</h2>
        <p class="practice-intro">한국인이 자주 겪는 스피치 상황 <b>${SITUATIONS.length}개</b>. 상황을 골라 실제로 말하고,
        핵심 포인트 점검 · 모범 답변 대비 · 피드백으로 연습하세요.${doneCount ? ` <b>${doneCount}회</b> 연습함.` : ""}</p>
        ${recCard}
        <div class="cat-scroll">${chips}</div>
      </div>
      <div>${cards}</div>`;
  }
  function wirePracticeBrowse() {
    $$(".cat-chip").forEach(c => c.addEventListener("click", () => { practiceCat = c.getAttribute("data-cat"); renderPractice(); }));
    $$(".sit-card").forEach(c => c.addEventListener("click", () => {
      state.activePractice = { sid: c.getAttribute("data-sid"), stage: "write", response: "", checked: [], aiFeedback: "" };
      save(); renderPractice(); window.scrollTo(0, 0);
    }));
  }

  function viewPracticeWrite(ap, s) {
    const cat = PRACTICE_CATS.find(c => c.key === s.cat);
    const timer = s.type === "talk" && s.speak ? viewTimerP(s) : "";
    const hint = s.type === "talk"
      ? "소리 내어 실제로 말해본 뒤, 말한 내용을 아래에 옮겨 적으세요."
      : "이 상황에서 당신이라면 뭐라고 할지, 실제 말투로 적어보세요.";
    return `
      <button class="sit-back" id="prac-back">← 상황 목록</button>
      <div class="sit-detail session-step">
        <span class="step-kicker">${cat ? cat.emoji + " " + esc(cat.label) : ""} · ${s.type === "talk" ? "발표" : "대화 반응"}</span>
        <h2 style="margin:2px 0 10px">${esc(s.title)}</h2>
        <div class="scene-box"><span class="emo">${cat ? cat.emoji : "🎤"}</span>${esc(s.scene)}</div>
        <div class="mission-box"><span class="lbl">🎯 미션</span><p>${esc(s.mission)}</p></div>
        ${timer}
        <p class="muted small" style="margin-top:12px">${hint}</p>
        <textarea id="prac-input" rows="7" placeholder="${s.type === "talk" ? "말한 내용을 옮겨 적기…" : "예: “부장님, 챙겨주셔서 감사합니다. 다만…”"}">${esc(ap.response)}</textarea>
        <div class="char-count" id="prac-count">0자</div>
        <button class="btn primary" id="prac-submit">제출하고 피드백 보기</button>
      </div>`;
  }
  function wirePracticeWrite(ap, s) {
    $("#prac-back").addEventListener("click", () => { state.activePractice = null; save(); renderPractice(); });
    const ta = $("#prac-input"), cc = $("#prac-count");
    const upd = () => { cc.textContent = charLen(ta.value) + "자"; };
    ta.addEventListener("input", () => { ap.response = ta.value; upd(); }); upd();
    if (s.type === "talk" && s.speak && $("#ptm-start")) setupTimerP(s);
    $("#prac-submit").addEventListener("click", () => {
      if (charLen(ta.value) < 10) { alert("조금 더 말해보세요 (최소 10자). 짧아도 좋으니 시도해봅시다!"); return; }
      ap.response = ta.value.trim(); ap.stage = "feedback"; stopTimerP(); save(); renderPractice(); window.scrollTo(0, 0);
    });
  }

  function viewPracticeFeedback(ap, s) {
    const useAI = aiReady();
    const checks = (s.tips || []).map((t, i) =>
      `<label class="check-item ${ap.checked.indexOf(i) >= 0 ? "checked" : ""}"><input type="checkbox" data-i="${i}" ${ap.checked.indexOf(i) >= 0 ? "checked" : ""}><span>${esc(t)}</span></label>`
    ).join("");
    const m = metrics(ap.response);
    return `
      <button class="sit-back" id="prac-back">← 상황 목록</button>
      <div class="sit-detail session-step">
        <span class="step-kicker">${esc(s.title)} · 피드백</span>

        <div class="section-label">내가 한 말</div>
        <div class="ai-answer">${esc(ap.response)}</div>

        <div class="section-label">스스로 점검 — 이걸 담았나요?</div>
        <p class="muted small" style="margin:-2px 0 8px">해당하는 것에 체크해보세요. 빠진 항목이 곧 다음 연습 포인트예요.</p>
        ${checks}

        <div class="section-label">✅ 모범 답변 (내 답과 비교해보세요)</div>
        <div class="model-answer">${esc(s.good)}</div>
        <div class="pitfall-box">⚠️ <b>흔한 실수</b> — ${esc(s.pitfall)}</div>

        <div class="fb-block fb-improve" style="margin-top:12px">
          <span class="fb-h">📊 관찰</span>
          분량 <b>${m.chars}자</b>, 문장 <b>${m.sentences}개</b>.
          ${s.type === "talk" ? (m.chars < 60 ? " 발표치고 조금 짧아요 — 근거·예시를 한 겹 더 얹어보세요." : " 발표 분량으로 적절해요.") : (m.chars > 180 ? " 대화 반응치고 길어요 — 핵심만 남겨 더 간결하게." : " 대화 반응으로 적절한 길이예요.")}
        </div>

        ${useAI ? aiSlotHTML("prac-ai", "prac-ask", !!ap.aiFeedback) : aiOffHint()}

        <button class="btn primary" id="prac-retry">다시 말해보기</button>
        <button class="btn ghost small" id="prac-save">저장하고 목록으로</button>
      </div>`;
  }
  function wirePracticeFeedback(ap, s) {
    $("#prac-back").addEventListener("click", () => { savePractice(ap, s); state.activePractice = null; save(); renderPractice(); });
    $$(".check-item input").forEach(inp => inp.addEventListener("change", () => {
      const i = parseInt(inp.getAttribute("data-i"), 10);
      const idx = ap.checked.indexOf(i);
      if (inp.checked && idx < 0) ap.checked.push(i);
      else if (!inp.checked && idx >= 0) ap.checked.splice(idx, 1);
      inp.closest(".check-item").classList.toggle("checked", inp.checked);
      save();
    }));
    $("#prac-retry").addEventListener("click", () => { ap.stage = "write"; ap.aiFeedback = ""; save(); renderPractice(); window.scrollTo(0, 0); });
    $("#prac-save").addEventListener("click", () => { savePractice(ap, s); state.activePractice = null; save(); renderPractice(); switchTab("tab-practice"); });
    if (aiReady()) {
      const el = $("#prac-ai");
      if (ap.aiFeedback) { if (el) el.innerHTML = renderAIFeedback(ap.aiFeedback); }
      else if (state.settings.aiSaver) {
        const ask = $("#prac-ask");
        if (ask) ask.addEventListener("click", () => requestPracticeAI(ap, s));
      } else requestPracticeAI(ap, s);
    }
  }
  function savePractice(ap, s) {
    if (charLen(ap.response) < 5) return;
    state.practices.push({
      sid: s.id, cat: s.cat, title: s.title, type: s.type,
      response: ap.response, checkedCount: ap.checked.length, tipsCount: (s.tips || []).length,
      aiFeedback: ap.aiFeedback || "", date: todayStr()
    });
  }

  /* 실전 발표용 타이머 (데일리 타이머와 분리) */
  function viewTimerP(s) {
    return `
    <div class="card" style="margin-top:12px">
      <div class="timer-wrap">
        <div class="timer-phase" id="ptm-phase">준비 시간</div>
        <div class="timer-display prep" id="ptm-display">${fmt(s.speak.prepSec || s.speak.speakSec)}</div>
        <div class="timer-controls">
          <button class="btn small btn-secondary" id="ptm-start">▶ 준비 시작</button>
          <button class="btn small ghost" id="ptm-reset">초기화</button>
        </div>
      </div>
      <p class="muted small" style="text-align:center;margin:6px 0 0">준비 ${s.speak.prepSec}초 → 말하기 ${s.speak.speakSec}초</p>
    </div>`;
  }
  let _ptId = null, _ptState = null;
  function setupTimerP(s) {
    _ptState = { phase: "prep", remain: s.speak.prepSec || s.speak.speakSec, prep: s.speak.prepSec, speak: s.speak.speakSec };
    const start = $("#ptm-start"), reset = $("#ptm-reset");
    start.addEventListener("click", () => { if (_ptId) return; start.textContent = "진행 중…"; start.disabled = true; _ptId = setInterval(tickP, 1000); });
    reset.addEventListener("click", stopTimerP);
  }
  function tickP() {
    const s = _ptState, disp = $("#ptm-display"), phase = $("#ptm-phase");
    if (!disp) { stopTimerP(); return; }
    s.remain--;
    if (s.remain <= 0) {
      if (s.phase === "prep" && s.speak) {
        s.phase = "speak"; s.remain = s.speak; phase.textContent = "🎤 말하기!"; disp.classList.remove("prep");
        if (navigator.vibrate) navigator.vibrate(200);
      } else {
        disp.textContent = "완료!"; disp.classList.add("done"); phase.textContent = "수고했어요 — 이제 옮겨 적으세요";
        if (navigator.vibrate) navigator.vibrate([120, 60, 120]); stopTimerP(true); return;
      }
    }
    disp.textContent = fmt(s.remain);
  }
  function stopTimerP(keep) {
    if (_ptId) { clearInterval(_ptId); _ptId = null; }
    const btn = $("#ptm-start");
    if (btn && !keep) { btn.textContent = "▶ 준비 시작"; btn.disabled = false;
      if (_ptState) { const d = $("#ptm-display"); if (d) { d.textContent = fmt(_ptState.prep || _ptState.speak); d.className = "timer-display prep"; } const p = $("#ptm-phase"); if (p) p.textContent = "준비 시간"; } }
  }

  const PRACTICE_SYSTEM = `당신은 한국인의 실전 말하기·대화를 돕는 스피치 코치입니다. 수사학과 화용론(pragmatics),
그리고 한국어의 공손 전략(존대·체면 유지)에 근거해 피드백합니다.

## 판단 기준
- 화용론적 적절성: 이 상황·상대·자리에서 그 말이 실제로 통하는가.
- 공손 전략(Brown & Levinson): 상대의 체면을 지키면서 내 뜻을 전달했는가. 과잉 완충으로 요점이
  사라지지도, 직설로 무례해지지도 않았는가.
- 구조(수사학): 발표라면 핵심 선행(PREP 등) · 근거 · 마무리가 있는가. 대화라면 상대의 말을 받고
  내 뜻을 얹었는가.
- 청자 반응 예측: 이 말을 들은 상대가 어떻게 느끼고 무엇을 할지.
- 형성평가(Hattie & Timperley): 목표 / 현재 / 다음 단계가 모두 드러나야 한다.

## 반드시 지킬 것
- 학습자가 실제로 한 말을 그대로 인용해 근거로 삼는다. 일반론 금지.
- 개선점은 최대 2가지. 각각 "그 말을 들은 상대가 어떻게 느낄지"를 한 줄로 붙인다.
- 통째로 대신 말해주지 않는다. 한 대목만 '전 → 후'로 시연한다.
- 상황에 맞는 한국어 말투(존댓말 수준, 자리의 분위기)를 고려한다.

## 출력 형식 (라벨 그대로, 각 항목 1~3문장)
[목표]
이 상황에서 좋은 말하기가 무엇인지 한 문장.
[현재]
학습자의 말이 지금 어떤 인상을 주는지. 실제 인용 근거로.
[잘한 점]
어느 표현이 왜 효과적이었는지 구체적으로.
[개선 1]
문제 → 상대가 받는 느낌 → 어떻게 바꿀지.
[개선 2]
(있으면. 없으면 생략)
[문장 수술]
전) 학습자가 한 말 한 대목
후) 고친 예
왜) 무엇이 달라졌는지
[스스로 찾기]
스스로 알아차리게 하는 질문 1~2개.
[다음 단계]
다시 말할 때 딱 하나 바꿀 것.

한국어. 전체 600~800자.`;

  async function requestPracticeAI(ap, s) {
    const slot = $("#prac-ai");
    if (slot) slot.innerHTML = `<span class="spinner"></span>AI 코치가 분석하고 있어요…`;
    const cat = PRACTICE_CATS.find(c => c.key === s.cat);
    const msg = `[상황 분류] ${cat ? cat.label : s.cat}
[상황] ${s.scene}
[미션] ${s.mission}
[유형] ${s.type === "talk" ? "발표/스피치 (혼자 길게 말함)" : "대화 반응 (상대에게 짧게 대응)"}
[이 상황의 핵심 포인트] ${(s.tips || []).join(" / ")}
[모범 답변 예시 — 참고용, 이대로 강요하지 말 것] ${s.good}
[이 상황의 흔한 실수] ${s.pitfall}

[학습자가 실제로 한 말]
${ap.response}

이 상황의 핵심 포인트를 기준으로, 지정된 출력 형식으로 피드백하세요.`;
    try {
      const out = await callAI(PRACTICE_SYSTEM, msg);
      ap.aiFeedback = out; save();
      if (slot) slot.innerHTML = renderAIFeedback(out);
    } catch (e) {
      if (slot) slot.innerHTML = `<span style="color:var(--danger)">AI 피드백 실패: ${esc(e.message)}. 설정에서 키/모델을 확인하세요.</span>
        <button class="btn ghost small" id="prac-ai-retry">다시 시도</button>`;
      const rb = $("#prac-ai-retry");
      if (rb) rb.addEventListener("click", () => requestPracticeAI(ap, s));
    }
  }

  /* ============================ 탭 전환 ============================ */
  function switchTab(id) {
    $$(".tab").forEach(t => t.classList.toggle("active", t.id === id));
    $$(".nav-btn").forEach(b => b.classList.toggle("active", b.getAttribute("data-tab") === id));
    if (id === "tab-practice") renderPractice();
    if (id === "tab-progress") renderProgress();
    if (id === "tab-log") renderLog();
    if (id === "tab-settings") renderSettings();
    window.scrollTo(0, 0);
  }

  /* ============================ 학습 알림 (듀오링고식 스트릭 독촉) ============================
   * 하루 2회(아침 권유 · 저녁 경고) — 오늘 이미 세션을 했으면 잔소리 대신 칭찬으로 바뀐다.
   * 두 갈래로 동작한다:
   *  1) 앱/탭이 켜져 있는 동안(백그라운드 포함) 30초마다 시간을 확인해 로컬 알림을 띄운다.
   *     안드로이드는 periodicSync로 완전히 닫혀 있어도 이 방식이 가끔 동작한다.
   *  2) '진짜 푸시' — 아이폰 홈 화면 앱(iOS 16.4+)처럼 앱이 완전히 닫혀 있어도
   *     서버가 보낸 push를 그대로 받는 방식. 구독까지는 이 앱이 만들지만,
   *     실제로 하루 두 번 그 구독에 push를 '보내는' 쪽(cron)은 별도 인프라가 필요해서
   *     아래 구독 코드를 클로드에게 전달해야 마지막 연결이 끝난다. */
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("coachdb", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function idbSet(key, value) {
    return idbOpen().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(value, key);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    }));
  }
  function idbGet(key) {
    return idbOpen().then(db => new Promise((resolve, reject) => {
      const req = db.transaction("kv").objectStore("kv").get(key);
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    }));
  }
  // 서비스 워커(백그라운드)는 localStorage를 못 읽으므로, 알림 판단에 필요한 값만 복사해 둔다
  function syncNotifyToIdb() {
    idbSet("notify", {
      settings: state.settings.notify,
      streak: state.streak,
      doneToday: !!state.activity[todayStr()],
      today: todayStr()
    }).catch(() => {});
  }

  async function setupPeriodicSync() {
    try {
      const reg = await navigator.serviceWorker.ready;
      if ("periodicSync" in reg) {
        await reg.periodicSync.register("coach-daily-reminder", { minInterval: 60 * 60 * 1000 });
      }
    } catch (e) { /* 미지원 브라우저나 권한 없음 — 앱이 열려 있을 때 방식으로만 동작 */ }
  }

  /* 오늘 이미 세션을 했으면 아침 알림은 건너뛰고, 저녁 알림은 잔소리 대신 칭찬으로 바뀐다 */
  function buildNotification(slot) {
    const doneToday = !!state.activity[todayStr()];
    const streak = state.streak || 0;
    if (slot === "morning") {
      if (doneToday) return null;
      return {
        title: streak > 0 ? `🔥 ${streak}일째 연속 학습 중!` : "✍️ 오늘의 코칭 세션",
        body: state.goals ? `“${state.goals}” — 오늘 5분만 투자해볼까요?` : "오늘의 글쓰기·말하기 과제가 기다리고 있어요."
      };
    }
    if (doneToday) {
      return { title: `✅ 오늘도 완료! ${streak}일 연속`, body: "내일도 이 페이스 그대로 가봐요." };
    }
    return {
      title: streak > 0 ? `⚠️ ${streak}일 연속 기록이 끊기기 직전이에요` : "🌙 오늘 아직 세션 전이에요",
      body: "자기 전에 딱 한 세션만 — 5분이면 충분해요."
    };
  }
  async function showCoachNotification(slot) {
    const msg = buildNotification(slot);
    if (!msg) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(msg.title, { body: msg.body, icon: "icon-192.png", badge: "icon-192.png", tag: "coach-" + slot });
    } catch (e) { /* 권한이 중간에 바뀌는 등 드문 경우 — 조용히 무시 */ }
  }
  function checkNotification() {
    const n = state.settings.notify;
    if (!n.enabled) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const now = new Date();
    const hhmm = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
    const t = todayStr();
    if (hhmm >= n.morning && n.lastMorning !== t) {
      n.lastMorning = t; save(); syncNotifyToIdb(); showCoachNotification("morning");
    }
    if (hhmm >= n.evening && n.lastEvening !== t) {
      n.lastEvening = t; save(); syncNotifyToIdb(); showCoachNotification("evening");
    }
  }

  /* ===== 진짜 푸시 구독 (앱이 닫혀 있어도 수신) =====
   * 공개키만 클라이언트에 둔다. 실제 발송(cron)은 이 구독 코드를 전달받은 뒤 별도로 연결한다. */
  const COACH_VAPID_PUBLIC_KEY = "BB0q2NFdDBvBvGfuNdkC4cMrTgp8t8YPoRxooRpJ1-CkXpD4DMPGuFhvaAkAYlDZzPcxkidagM7sGbPAOCzSbCk";
  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    return Uint8Array.from([...raw].map(ch => ch.charCodeAt(0)));
  }

  function updateNotifyUI() {
    const n = state.settings.notify;
    const mt = $("#notify-morning"), et = $("#notify-evening"), tog = $("#notify-toggle");
    if (!mt) return;
    mt.value = n.morning; et.value = n.evening;
    if (n.enabled && "Notification" in window && Notification.permission === "granted") {
      tog.textContent = "알림 끄기";
      setStatus("#notify-status", `✅ 매일 ${n.morning}·${n.evening} 두 번 알림을 시도해요 (앱이 켜져 있을 때). 완전히 닫혀 있어도 받으려면 아래 '진짜 푸시'를 연결하세요.`, "ok");
    } else {
      tog.textContent = "알림 켜기";
      setStatus("#notify-status", "알림이 꺼져 있어요.", "");
    }
  }
  function wireNotifyOnce() {
    const tog = $("#notify-toggle");
    if (!tog) return;
    tog.addEventListener("click", async () => {
      if (!("Notification" in window)) { setStatus("#notify-status", "이 브라우저는 알림을 지원하지 않아요.", "err"); return; }
      const n = state.settings.notify;
      if (n.enabled) {
        n.enabled = false;
      } else {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          setStatus("#notify-status", "⚠️ 알림이 차단되어 있어요. 기기 설정에서 이 앱의 알림을 허용해 주세요.", "err");
          return;
        }
        n.enabled = true;
        n.morning = $("#notify-morning").value || "09:00";
        n.evening = $("#notify-evening").value || "20:30";
        setupPeriodicSync();
      }
      save(); syncNotifyToIdb(); updateNotifyUI();
    });
    ["#notify-morning", "#notify-evening"].forEach(sel => {
      const el = $(sel); if (!el) return;
      el.addEventListener("change", () => {
        state.settings.notify.morning = $("#notify-morning").value || "09:00";
        state.settings.notify.evening = $("#notify-evening").value || "20:30";
        save(); syncNotifyToIdb(); updateNotifyUI();
      });
    });
    const test = $("#notify-test");
    if (test) test.addEventListener("click", async () => {
      if (!("Notification" in window)) { setStatus("#notify-status", "이 브라우저는 알림을 지원하지 않아요.", "err"); return; }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { setStatus("#notify-status", "⚠️ 알림이 차단되어 있어요.", "err"); return; }
      try {
        const reg = await navigator.serviceWorker.ready;
        const doneToday = !!state.activity[todayStr()];
        await reg.showNotification(doneToday ? "✅ 미리보기 — 완료 축하 알림" : "🔥 미리보기 — 스트릭 독촉 알림", {
          body: doneToday ? "오늘도 완료! 이 페이스 그대로 가봐요." : "오늘 세션 아직이에요. 5분만 투자해볼까요?",
          icon: "icon-192.png", badge: "icon-192.png", tag: "coach-preview"
        });
      } catch (e) {
        setStatus("#notify-status", "⚠️ 미리보기 표시 실패: " + e.message, "err");
      }
    });
    const sub = $("#push-subscribe");
    if (sub) sub.addEventListener("click", async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setStatus("#push-status", "⚠️ 이 브라우저에서는 푸시를 쓸 수 없어요. 아이폰이라면 사파리에서 '홈 화면에 추가'로 설치한 앱에서 눌러주세요. (iOS 16.4 이상)", "err");
        return;
      }
      try {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") { setStatus("#push-status", "⚠️ 알림 권한이 거부됐어요. 설정에서 이 앱의 알림을 허용해 주세요.", "err"); return; }
        const reg = await navigator.serviceWorker.ready;
        const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(COACH_VAPID_PUBLIC_KEY) });
        $("#push-json").value = JSON.stringify(s.toJSON());
        $("#push-result").hidden = false;
        setStatus("#push-status", "✅ 구독 생성 완료! 위 코드를 복사해서 클로드에게 붙여넣어 주세요.", "ok");
      } catch (e) {
        setStatus("#push-status", "⚠️ 구독 생성 실패: " + e.message, "err");
      }
    });
    const copy = $("#push-copy");
    if (copy) copy.addEventListener("click", async () => {
      const ta = $("#push-json"); ta.select();
      try { await navigator.clipboard.writeText(ta.value); setStatus("#push-status", "📋 복사됐어요! 클로드에게 붙여넣어 주세요.", "ok"); }
      catch (e) { document.execCommand("copy"); setStatus("#push-status", "📋 복사됐어요! 클로드에게 붙여넣어 주세요.", "ok"); }
    });
  }

  /* ============================ 아이폰 설치 안내 ============================ */
  function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }
  function isStandalone() {
    return window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  }
  function showInstallSheet() { const s = $("#ios-install"); if (s) s.hidden = false; }
  function hideInstallSheet() { const s = $("#ios-install"); if (s) s.hidden = true; }
  function setupInstall() {
    const close = () => { hideInstallSheet(); state.iosHintShown = true; save(); };
    const x = $("#ios-install-close"), ok = $("#ios-install-ok"), show = $("#show-install");
    if (x) x.addEventListener("click", close);
    if (ok) ok.addEventListener("click", close);
    if (show) show.addEventListener("click", showInstallSheet);
    // 설정 카드 상태
    const note = $("#installed-note");
    if (isStandalone()) {
      if (note) note.style.display = "block";
      if (show) show.style.display = "none";
    }
    // iOS 사파리에서 아직 설치 안 했고, 안내를 본 적 없으면 한 번 자동 표시
    if (isIOS() && !isStandalone() && !state.iosHintShown) {
      setTimeout(showInstallSheet, 900);
    }
  }

  /* ============================ 초기화 ============================ */
  function init() {
    $$(".nav-btn").forEach(b => b.addEventListener("click", () => switchTab(b.getAttribute("data-tab"))));
    save();   // 구버전 설정 이관 결과를 즉시 영구 저장
    wireSettingsOnce();
    wireModeBar();
    wireNotifyOnce();
    setupInstall();
    renderAll();
    updateNotifyUI();
    syncNotifyToIdb();
    checkNotification();
    setInterval(checkNotification, 30 * 1000);
    if (state.settings.notify.enabled) setupPeriodicSync();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").then(async (reg) => {
        // 백그라운드에서 이미 알림을 보냈다면(IndexedDB에 기록됨) 중복 발송 방지를 위해 반영
        try {
          const idbNotify = await idbGet("notify");
          const n = state.settings.notify;
          if (idbNotify && idbNotify.settings) {
            if (idbNotify.settings.lastMorning > n.lastMorning) n.lastMorning = idbNotify.settings.lastMorning;
            if (idbNotify.settings.lastEvening > n.lastEvening) n.lastEvening = idbNotify.settings.lastEvening;
            save();
          }
        } catch (e) { /* 무시 */ }
        // 아이폰 홈 화면 앱(standalone)은 새 버전이 나와도 자동으로 갱신 확인을 안 하는
        // 경우가 있다(iOS WebKit의 알려진 문제) — 그래서 앱을 열 때마다 직접 확인을 요청한다.
        reg.update().catch(() => {});
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") reg.update().catch(() => {});
        });
      }).catch(() => {});
      // 새 버전의 서비스 워커가 제어권을 넘겨받으면 한 번 새로고침해 새 화면을 바로 반영한다.
      // 홈 화면에 설치해 거의 안 닫는 아이폰 앱에서는 이게 없으면 새 기능이 안 보이는 채로 남는다.
      let _swRefreshed = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (_swRefreshed) return;
        _swRefreshed = true;
        location.reload();
      });
    }
  }
  document.addEventListener("DOMContentLoaded", init);
})();
