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
  const TRACK_PATTERN = ["write", "quality", "speak", "write", "quality", "speak", "review"];
  const TRACK_NAMES = { write: "구조", quality: "품질", speak: "말하기", review: "복습·통합", diagnostic: "진단" };
  const TRACK_ICONS = { write: "✍️ 구조", quality: "✨ 품질", speak: "🎙️ 말하기", review: "🔁 복습·통합" };

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
      quality: [],            // 품질 6축 추이 [{date, day, scores, avg}]
      drills: { done: [], correct: 0, total: 0 },  // A/B 안목 훈련 기록
      aiUsage: { date: "", count: 0 },  // 오늘 AI 호출 수 (절약 확인용)
      settings: {
        aiEnabled: false,
        aiSaver: true,        // 절약 모드: AI 피드백을 탭할 때만 호출
        provider: "gemini",   // 'gemini'(무료) | 'anthropic'(유료)
        gemini: { key: "", model: "gemini-2.5-flash" },
        anthropic: { key: "", model: "claude-sonnet-5" }
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
    if (!s.plan) s.plan = {};
    if (!s.quality) s.quality = [];
    if (!s.drills) s.drills = { done: [], correct: 0, total: 0 };
    if (!s.aiUsage) s.aiUsage = { date: "", count: 0 };
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
  const ALL_LESSONS = CURRICULUM.concat(QUALITY_LESSONS);
  const WRITE_POOL = CURRICULUM.filter(l => l.track === "write");
  const SPEAK_POOL = CURRICULUM.filter(l => l.track === "speak");
  const QUALITY_POOL = QUALITY_LESSONS;
  const POOLS = { write: WRITE_POOL, speak: SPEAK_POOL, quality: QUALITY_POOL };
  const byId = (id) => ALL_LESSONS.find(l => l.id === id);
  const dimOf = (key) => QUALITY_DIMS.find(d => d.key === key);

  function trackForDay(day) {
    if (day <= 1) return "diagnostic";
    return TRACK_PATTERN[(day - 2) % TRACK_PATTERN.length];
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
반드시 최소 1개는 good을 포함하고, 인용은 학습자 글의 실제 표현이어야 합니다.`;

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
      const raw = await callAI(QUALITY_SYSTEM, qualityUserMessage(text, ctx), 2048);
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
      aiFeedback: "", aiRetryFeedback: "", summary: "", selfRating: null,
      dim: lesson.dim || "",
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
    if (state.diagnosis && state.diagnosis.status === "pending") {
      root.innerHTML = viewDiagnosing();
      runDiagnosis();
      return;
    }
    const sess = state.activeSession;
    if (!sess) { root.innerHTML = viewStart(); wireStart(); return; }

    const stageViews = {
      brief: [viewBrief, wireBrief],
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
  "writeFocus": ["구조 기술 id 2개 — 첫 주에 다룰 순서대로"],
  "speakFocus": ["말하기 기술 id 2개 — 순서대로"],
  "qualityFocus": ["품질 기술 id 2개 — 이 학습자의 글에서 가장 시급한 품질 축부터"],
  "advice": "첫 주에 특히 신경 쓸 것을 3~4문장으로. 학습자의 목표와 연결해서."
}
strengths는 1~2개, weaknesses는 2~3개. quote는 반드시 학습자 글의 실제 표현이어야 합니다(없으면 빈 문자열).
skillId·writeFocus·speakFocus·qualityFocus는 반드시 주어진 id 목록에서만 고르세요.
weaknesses의 skillId는 구조·품질 목록 어디서든 고를 수 있습니다.`;

  function diagUserMessage(text, goal) {
    const wl = WRITE_POOL.map(l => `${l.id}: ${l.skill}`).join("\n");
    const sl = SPEAK_POOL.map(l => `${l.id}: ${l.skill}`).join("\n");
    const ql = QUALITY_POOL.map(l => `${l.id}: ${l.skill} [${(dimOf(l.dim) || {}).label || l.dim}]`).join("\n");
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

위 학습자를 진단하고 맞춤 커리큘럼을 JSON으로 설계하세요.`;
  }

  /* 모델이 코드블록이나 잡텍스트를 섞어도 JSON을 건져낸다 */
  function extractJSON(s) {
    let t = String(s).trim();
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b <= a) throw new Error("JSON 형식이 아닙니다");
    return JSON.parse(t.slice(a, b + 1));
  }

  /* 진단 결과를 실제 트랙 패턴의 날짜에 배치한다(패턴이 바뀌어도 따라간다) */
  function daysForTrack(track, fromDay, toDay) {
    const out = [];
    for (let d = fromDay; d <= toDay; d++) if (trackForDay(d) === track) out.push(d);
    return out;
  }
  function buildPlanFromFocus(writeFocus, speakFocus, qualityFocus) {
    const pick = (ids, pool) => (ids || []).filter(id => pool.find(l => l.id === id));
    const map = [
      ["write", pick(writeFocus, WRITE_POOL)],
      ["speak", pick(speakFocus, SPEAK_POOL)],
      ["quality", pick(qualityFocus, QUALITY_POOL)]
    ];
    const plan = {};
    map.forEach(([track, ids]) => {
      const days = daysForTrack(track, 2, 8);
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
      const raw = await callAI(DIAG_SYSTEM, diagUserMessage(text, state.goals), 2048);
      const j = extractJSON(raw);
      const weaknesses = (j.weaknesses || []).filter(w => w && byId(w.skillId));
      state.diagnosis = {
        status: "done", source: "ai",
        level: j.level || "", levelWhy: j.levelWhy || "",
        summary: j.summary || "", strengths: j.strengths || [],
        weaknesses: weaknesses, advice: j.advice || "", date: todayStr()
      };
      state.plan = buildPlanFromFocus(j.writeFocus, j.speakFocus, j.qualityFocus);
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
      state.plan = buildPlanFromFocus(ofTrack("write"), ofTrack("speak"), ofTrack("quality"));
      ws.forEach(w => { state.skills[w.skillId] = { rating: 1, seen: 0, lastDay: 0 }; });
    }
    _diagRunning = false;
    save();
    renderToday();
    renderProgress();
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
    for (let day = 2; day <= 8; day++) {
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
      <div class="card">
        <h2>🗺️ 나에게 맞춘 첫 주 커리큘럼</h2>
        <p class="muted small">진단에서 나온 약점을 앞쪽에 배치했어요. 진행하면서 자동으로 조정됩니다.</p>
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
    </div>`;
  }
  function wireStart() {
    $("#start-session").addEventListener("click", startNextSession);
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
  /* 회차별 초점 — 품질 레슨은 revisePasses 정의를 쓰고, 없으면 1회(L.retry) */
  function revisePassInfo(L, pass) {
    const rp = L.revisePasses;
    if (rp && rp[pass - 1]) return rp[pass - 1];
    if (pass === 1) return { focus: L.dim || null, instruction: L.retry || "피드백을 반영해 고쳐 쓰세요." };
    return { focus: null, instruction: "한 번 더 다듬어 보세요." };
  }
  function revisePassCount(L) {
    return (L.revisePasses && L.revisePasses.length) || 1;
  }
  function lastRevisionText(sess) {
    const revs = sess.revisions || [];
    if (revs.length) return revs[revs.length - 1].text;
    return sess.retry || sess.submission || "";
  }
  function wireRetry(sess, L) {
    const ta = $("#retry-text"), cc = $("#retry-count");
    const upd = () => { cc.textContent = charLen(ta.value) + "자"; };
    ta.addEventListener("input", upd); upd();
    $("#retry-submit").addEventListener("click", () => {
      const text = ta.value.trim();
      if (charLen(text) < 5) { alert("고쳐 쓴 내용을 조금 더 적어 주세요."); return; }
      const pass = (sess.revisePass || 0) + 1;
      const info = revisePassInfo(L, pass);
      sess.revisions = sess.revisions || [];
      sess.revisions.push({ pass, focus: info.focus || "", text: text });
      sess.retry = text;              // 기록 호환
      sess.revisePass = pass;
      sess.stage = pass < revisePassCount(L) ? "revise-more" : "wrap";
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
    return `
    <div class="session-step">
      <span class="step-kicker ${L.track}">DAY ${sess.day} · 마무리</span>

      ${compareBlock}

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

    // 기술 그리드 — 트랙별로 묶어서 표시
    const grid = $("#skill-grid");
    const chip = (l) => {
      const sk = state.skills[l.id];
      const cls = !sk ? "d-none" : sk.rating === 1 ? "d-weak" : sk.rating === 2 ? "d-mid" : sk.rating >= 3 ? "d-strong" : "d-none";
      return `<div class="skill-chip"><span class="sname">${esc(l.skill.split(" — ")[0])}</span><span class="dot ${cls}"></span></div>`;
    };
    grid.innerHTML = ["write", "quality", "speak"].map(t => {
      const pool = POOLS[t] || [];
      if (!pool.length) return "";
      return `<div class="skill-group"><div class="skill-group-h">${TRACK_ICONS[t] || t}</div>
        <div class="skill-group-grid">${pool.map(chip).join("")}</div></div>`;
    }).join("");

    renderQualityPanel();
    renderDrillStat();
    renderHeatmap();
    renderWeeklyReview();
  }

  /* 품질 6축 추이 — 첫 리포트 대비 최신 리포트, 축별 평균과 스파크라인 */
  function renderQualityPanel() {
    const card = $("#quality-card"), el = $("#quality-panel");
    if (!card || !el) return;
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
    const d = state.drills || { total: 0 };
    if (!d.total) { card.style.display = "none"; return; }
    card.style.display = "block";
    const acc = Math.round(d.correct / d.total * 100);
    const covered = (d.done || []).length;
    el.innerHTML = `
      <div class="stat-row" style="margin:0">
        <div class="card stat-card" style="margin:0"><div class="stat-value">${d.total}</div><div class="stat-label">푼 문제</div></div>
        <div class="card stat-card" style="margin:0"><div class="stat-value">${acc}%</div><div class="stat-label">정답률</div></div>
        <div class="card stat-card" style="margin:0"><div class="stat-value">${covered}/${AB_DRILLS.length}</div><div class="stat-label">경험한 유형</div></div>
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
  function renderSettings() {
    uiProvider = state.settings.provider || "gemini";
    $("#set-provider").value = uiProvider;
    refreshProviderUI();
    $("#set-ai-enabled").checked = !!state.settings.aiEnabled;
    $("#set-ai-saver").checked = !!state.settings.aiSaver;
    $("#ai-usage-count").textContent = todayAIUsage();
  }
  function wireSettingsOnce() {
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
  }
  function todayAIUsage() {
    return state.aiUsage.date === todayStr() ? state.aiUsage.count : 0;
  }

  function callAI(system, userMsg, maxTokens) {
    countAIUsage();
    return state.settings.provider === "anthropic"
      ? callAnthropic(system, userMsg, maxTokens)
      : callGemini(system, userMsg, maxTokens);
  }

  async function callGemini(system, userMsg, maxTokens) {
    const model = currentModel() || "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(currentKey())}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: userMsg }] }],
        generationConfig: { maxOutputTokens: maxTokens || 1600, temperature: 0.7 }
      })
    });
    if (!res.ok) {
      let detail = ""; try { detail = (await res.json()).error?.message || ""; } catch (e) {}
      throw new Error(`${res.status} ${detail || "요청 실패"}`);
    }
    const data = await res.json();
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const text = parts.map(p => p.text || "").join("").trim();
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
  function extractCharLimit(constraints) {
    for (const c of (constraints || [])) {
      const m = String(c).match(/(\d+)\s*자\s*(이내|이하)/);
      if (m) return parseInt(m[1], 10);
    }
    return 0;
  }

  /* ============================ 실전 말하기 ============================ */
  let practiceCat = "all";
  const sitById = (id) => SITUATIONS.find(s => s.id === id);

  let practiceMode = "situations";   // 'situations' | 'drills'
  function segmentHTML() {
    const d = state.drills || { total: 0 };
    return `
      <div class="seg-row">
        <button class="seg ${practiceMode === "situations" ? "active" : ""}" data-mode="situations">🎤 상황별 말하기</button>
        <button class="seg ${practiceMode === "drills" ? "active" : ""}" data-mode="drills">👁️ 안목 훈련${d.total ? `<span class="seg-n">${d.total}</span>` : ""}</button>
      </div>`;
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
    if (practiceMode === "drills") {
      root.innerHTML = segmentHTML() + viewDrill();
      wireSegments(); wireDrill();
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

  /* ==================== A/B 안목 훈련 (API 0원) ====================
   * 절대 채점보다 비교 판단이 정확하다는 평가 연구에 기반.
   * 먼저 고르게 하고(주목), 그다음 원리를 보여준다.
   * ============================================================== */
  let drillState = null;   // { drill, picked, revealed }
  let drillFilter = "all";

  function drillPool() {
    return AB_DRILLS.filter(d => drillFilter === "all" || d.dim === drillFilter);
  }
  function nextDrill() {
    const pool = drillPool();
    const done = (state.drills.done || []);
    const fresh = pool.filter(d => done.indexOf(d.id) < 0);
    const src = fresh.length ? fresh : pool;     // 다 풀면 다시 섞어서 반복
    return src[Math.floor(Math.random() * src.length)] || null;
  }
  function viewDrill() {
    const d = state.drills || { done: [], correct: 0, total: 0 };
    const chips = [{ key: "all", label: "전체", emoji: "✨" }].concat(QUALITY_DIMS.map(x => ({ key: x.key, label: x.label, emoji: x.emoji })))
      .map(c => {
        const n = c.key === "all" ? AB_DRILLS.length : AB_DRILLS.filter(x => x.dim === c.key).length;
        return `<button class="cat-chip ${drillFilter === c.key ? "active" : ""}" data-dim="${c.key}">${c.emoji} ${esc(c.label)}<span class="n">${n}</span></button>`;
      }).join("");
    if (!drillState) drillState = { drill: nextDrill(), picked: null, revealed: false };
    const dr = drillState.drill;
    if (!dr) return `<div class="card"><p class="empty-msg">이 분야의 문제가 없어요.</p></div>`;
    const dim = dimOf(dr.dim);
    const acc = d.total ? Math.round(d.correct / d.total * 100) : 0;
    const picked = drillState.picked, revealed = drillState.revealed;
    const optCls = (k) => {
      if (!revealed) return picked === k ? "picked" : "";
      if (k === dr.better) return "correct";
      return picked === k ? "wrong" : "dim";
    };
    return `
      <div class="card" style="padding:14px 16px">
        <h2 style="margin-bottom:6px">👁️ 안목 훈련 <span class="sub">A/B 비교</span></h2>
        <p class="practice-intro">둘 중 <b>어느 쪽이 더 좋은지 먼저 고르고</b>, 그다음 이유를 확인하세요.
        규칙을 외우기보다 차이를 알아차리는 것이 실력이 됩니다. ${d.total ? `<b>${d.total}문제</b> 중 정답률 <b>${acc}%</b>` : ""}
        <span class="muted" style="font-size:12px">· AI 호출 없음</span></p>
        <div class="cat-scroll">${chips}</div>
      </div>

      <div class="card">
        <div class="drill-dim">${dim ? `${dim.emoji} ${esc(dim.label)}` : ""} · ${esc(dim ? dim.short : "")}</div>
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
        ` : `<p class="muted small" style="margin-top:12px">고르면 해설이 나옵니다.</p>`}
      </div>`;
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
      state.drills.total = (state.drills.total || 0) + 1;
      if (pick === dr.better) state.drills.correct = (state.drills.correct || 0) + 1;
      state.drills.done = state.drills.done || [];
      if (state.drills.done.indexOf(dr.id) < 0) state.drills.done.push(dr.id);
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
  }

  function viewPracticeBrowse() {
    const cats = [{ key: "all", label: "전체", emoji: "✨" }].concat(PRACTICE_CATS);
    const chips = cats.map(c => {
      const n = c.key === "all" ? SITUATIONS.length : SITUATIONS.filter(s => s.cat === c.key).length;
      return `<button class="cat-chip ${practiceCat === c.key ? "active" : ""}" data-cat="${c.key}">${c.emoji} ${esc(c.label)}<span class="n">${n}</span></button>`;
    }).join("");
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
    setupInstall();
    renderAll();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }
  document.addEventListener("DOMContentLoaded", init);
})();
