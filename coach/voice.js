/* ======================================================================
 * voice.js — 실제 '말'을 듣는 층
 *
 * 왜 필요한가:
 *   이 앱은 말하기 코치인데, 지금까지 모든 말하기 과제가 '타이핑'이었다.
 *   타이핑한 글에서는 말하기의 핵심 지표를 하나도 잴 수 없다.
 *   말이 빠른지, 어디서 쉬는지, 쉼 없이 몰아붙이는지, 채움말이 분당 몇 번인지 —
 *   이건 전부 실제 발화에서만 나온다. 글로 옮겨 적는 순간 다 사라진다.
 *   (게다가 옮겨 적으면 무의식적으로 문장을 다듬게 되어, 실제보다 잘 말한 것처럼 기록된다.)
 *
 * 무엇을 재는가 (두 갈래를 동시에 씀):
 *   1) SpeechRecognition — 말을 글로 (전사)
 *   2) AudioContext 음량 분석 — 말한 시간 / 쉰 시간 / 쉼의 개수와 길이
 *      전사만으로는 '쉼'을 못 잰다. 음량을 50ms마다 재야 정확히 나온다.
 *
 * 지원 안 되는 환경(구형 브라우저 등)에서는 조용히 비활성화되고,
 * 기존처럼 직접 타이핑하는 방식이 그대로 남는다.
 * ====================================================================== */

const Voice = (function () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  function supported() {
    return !!SR && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }
  /* 전사는 안 되지만 녹음 분석은 되는 환경도 있다(반대도 마찬가지) */
  function transcriptSupported() { return !!SR; }

  /* 음량 기반 쉼 측정.
     사람의 '쉼'은 무음이 아니라 '주변 소음 수준으로 떨어진 구간'이다.
     그래서 고정 임계값 대신 초반 소음을 재서 기준선을 잡는다. */
  function createMeter(stream) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);

    const SAMPLE_MS = 50;
    const PAUSE_MS = 600;          // 이보다 길게 조용하면 '쉼' 1회로 센다
    let samples = 0, loudSamples = 0;
    let noiseFloor = null, calibN = 0, calibSum = 0;
    let silentRun = 0;
    const pauses = [];
    let timer = null;

    function rms() {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / buf.length);
    }
    function tick() {
      const level = rms();
      samples++;
      // 첫 0.5초는 주변 소음 보정 구간
      if (calibN < 10) { calibSum += level; calibN++; if (calibN === 10) noiseFloor = calibSum / 10; return; }
      const threshold = Math.max((noiseFloor || 0) * 2.2, 0.012);
      if (level > threshold) {
        loudSamples++;
        if (silentRun * SAMPLE_MS >= PAUSE_MS) pauses.push(silentRun * SAMPLE_MS);
        silentRun = 0;
      } else {
        silentRun++;
      }
    }
    timer = setInterval(tick, SAMPLE_MS);

    return {
      stop() {
        clearInterval(timer);
        try { ctx.close(); } catch (e) { /* 이미 닫혔으면 무시 */ }
        // 마지막이 쉼으로 끝났으면 그것도 센다(말끝을 흐리는 습관이 여기 잡힌다)
        if (silentRun * SAMPLE_MS >= PAUSE_MS) pauses.push(silentRun * SAMPLE_MS);
        const totalMs = samples * SAMPLE_MS;
        const voicedMs = loudSamples * SAMPLE_MS;
        return {
          totalMs: totalMs,
          voicedMs: voicedMs,
          silentMs: Math.max(0, totalMs - voicedMs),
          pauseCount: pauses.length,
          longestPauseMs: pauses.length ? Math.max.apply(null, pauses) : 0,
          pauses: pauses
        };
      }
    };
  }

  /* 녹음 세션 하나. start()로 시작하고 stop()으로 결과를 받는다. */
  function createSession(opts) {
    opts = opts || {};
    let rec = null, meter = null, stream = null;
    let finalText = "", interimText = "";
    let startedAt = 0, stopped = false;

    async function start() {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      meter = createMeter(stream);
      startedAt = Date.now();

      if (SR) {
        rec = new SR();
        rec.lang = "ko-KR";
        rec.continuous = true;
        rec.interimResults = true;
        rec.onresult = (e) => {
          let interim = "";
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i];
            if (r.isFinal) finalText += r[0].transcript;
            else interim += r[0].transcript;
          }
          interimText = interim;
          if (opts.onText) opts.onText((finalText + " " + interimText).trim());
        };
        // 브라우저가 임의로 끊는 경우가 있어, 사용자가 멈추기 전이면 다시 이어붙인다
        rec.onend = () => { if (!stopped) { try { rec.start(); } catch (e) { /* 중복 시작 무시 */ } } };
        rec.onerror = (e) => {
          if (e.error === "not-allowed" || e.error === "service-not-allowed") {
            if (opts.onError) opts.onError("마이크 권한이 필요해요.");
          }
        };
        try { rec.start(); } catch (e) { /* 이미 시작됨 */ }
      }
      if (opts.onTick) {
        opts.onTick(0);
        const t = setInterval(() => {
          if (stopped) return clearInterval(t);
          opts.onTick(Math.floor((Date.now() - startedAt) / 1000));
        }, 250);
      }
    }

    function stop() {
      stopped = true;
      if (rec) { try { rec.stop(); } catch (e) { /* 무시 */ } }
      const audio = meter ? meter.stop() : null;
      if (stream) stream.getTracks().forEach(t => t.stop());
      const text = (finalText + " " + interimText).trim();
      return { text: text, audio: audio, metrics: computeMetrics(text, audio) };
    }
    return { start: start, stop: stop };
  }

  /* 실제 발화에서만 나오는 지표.
     한국어는 단어 경계가 영어와 달라 WPM 대신 '분당 어절'을 쓴다. */
  function computeMetrics(text, audio) {
    if (!audio || !audio.totalMs) return null;
    const sec = audio.totalMs / 1000;
    const min = sec / 60;
    const words = (String(text || "").trim().match(/\S+/g) || []).length;
    const fillerHits = String(text || "").match(/(^|\s)(음+|어+|그+|저기|약간|좀|이제|뭐랄까)(\s|$)/g) || [];
    return {
      seconds: Math.round(sec),
      words: words,
      wordsPerMin: min > 0.05 ? Math.round(words / min) : 0,
      pauseCount: audio.pauseCount,
      pausePerMin: min > 0.05 ? +(audio.pauseCount / min).toFixed(1) : 0,
      longestPauseSec: +(audio.longestPauseMs / 1000).toFixed(1),
      silentRatio: audio.totalMs ? Math.round(audio.silentMs / audio.totalMs * 100) : 0,
      fillerCount: fillerHits.length,
      fillerPerMin: min > 0.05 ? +(fillerHits.length / min).toFixed(1) : 0
    };
  }

  /* 지표 해석 — 기준값은 한국어 발표·대화 연구에서 통용되는 범위를 따랐다.
     편안하게 들리는 구간은 분당 220~300어절, 쉼은 분당 5~12회. */
  function judge(m) {
    if (!m) return [];
    // 몇 초짜리 녹음에서 분당 수치를 뽑으면 말도 안 되는 값이 나온다. 그냥 못 쟀다고 말한다.
    if (m.seconds < 5) {
      return [{ key: "측정", value: m.seconds + "초", ok: false,
                note: "너무 짧아 속도·쉼을 잴 수 없어요. 최소 10초 이상 말해보세요." }];
    }
    const out = [];
    if (m.wordsPerMin) {
      out.push(m.wordsPerMin > 330
        ? { key: "속도", value: m.wordsPerMin + " 어절/분", ok: false, note: "빠릅니다. 청자가 따라올 틈이 없어요." }
        : m.wordsPerMin < 190
          ? { key: "속도", value: m.wordsPerMin + " 어절/분", ok: false, note: "느립니다. 늘어지면 집중이 흩어져요." }
          : { key: "속도", value: m.wordsPerMin + " 어절/분", ok: true, note: "듣기 편한 속도입니다." });
    }
    out.push(m.pausePerMin >= 5 && m.pausePerMin <= 14
      ? { key: "쉼", value: m.pausePerMin + "회/분", ok: true, note: "문장 사이에 숨 쉴 자리가 있어요." }
      : m.pausePerMin < 5
        ? { key: "쉼", value: m.pausePerMin + "회/분", ok: false, note: "쉼 없이 몰아붙였어요. 중요한 말 앞에서 한 번 멈춰보세요." }
        : { key: "쉼", value: m.pausePerMin + "회/분", ok: false, note: "끊김이 잦아요. 문장을 짧게 정리하고 이어가세요." });
    out.push(m.fillerPerMin <= 3
      ? { key: "채움말", value: m.fillerPerMin + "회/분", ok: true, note: "군더더기가 적습니다." }
      : { key: "채움말", value: m.fillerPerMin + "회/분", ok: false, note: "'음/어/그'가 잦아요. 그 자리를 침묵으로 바꿔보세요." });
    if (m.longestPauseSec >= 3) {
      out.push({ key: "가장 긴 쉼", value: m.longestPauseSec + "초", ok: false, note: "말문이 막힌 구간이 있었어요. 다음 회차에 그 지점을 미리 준비해보세요." });
    }
    return out;
  }

  return {
    supported: supported,
    transcriptSupported: transcriptSupported,
    createSession: createSession,
    computeMetrics: computeMetrics,
    judge: judge
  };
})();

if (typeof module !== "undefined") module.exports = { Voice };
