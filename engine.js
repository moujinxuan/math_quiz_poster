// Static (no-backend) engine for the GitHub Pages build of the quiz.
//
// index.html talks to the backend with fetch(`${API}/session`) etc. This
// file is loaded before it (see build_static.py) and answers those same
// four endpoints in the browser instead, so the page itself stays
// identical to the backend-served version. The logic mirrors the Python
// backend: adaptive.py (weighted sampling + weight updates), mc_options.py
// (diagnostic options), main.py (_apply_diagnostic_weights, feedback text,
// parent report). Questions come from the pre-generated bank.jsonl
// (gen_bank.py) instead of a live Gemini call, and open answers are scored
// by number + unit matching instead of the Gemini judge.
(function () {
  'use strict';

  const COMBO_KEYS = ['operation', 'carry_borrow', 'nominalization', 'lexical_consistency',
                      'presentation_order', 'question_placement', 'distractor'];
  const OPTIONS = {
    operation:           ['加法', '減法'],
    carry_borrow:        [true, false],
    nominalization:      [true, false],
    lexical_consistency: [true, false],
    presentation_order:  [true, false],
    question_placement:  ['before', 'after'],
    distractor:          ['none', 'linguistic', 'numerical', 'both'],
    response_mode:       ['open', 'multiple_choice'],
  };
  const SLIP = 10;

  // Same tables as prompts.py's PARAM_WEAKNESS_DESCRIPTIONS / _TIPS.
  const WEAKNESS_DESCRIPTIONS = {
    'operation=加法': '加法運算',
    'operation=減法': '減法運算',
    'carry_borrow=True': '需要進位或借位的計算',
    'lexical_consistency=False': '題目用詞（例如「多」「少」）暗示的方向，跟實際該用的算法相反的題目',
    'presentation_order=False': '題目敘述的順序跟實際計算需要的順序不同、需要重新整理資訊的題目',
    'distractor=linguistic': '包含跟解題無關的背景描述的題目',
    'distractor=numerical': '包含跟解題無關的數字的題目',
    'distractor=both': '同時包含跟解題無關的背景描述和數字的題目',
  };
  const WEAKNESS_TIPS = {
    operation: '可以多做幾次這個運算的口算練習，熟悉基本加減法。',
    carry_borrow: '可以加強進位、借位的直式計算練習，搭配積木等教具幫助理解進位/借位的概念。',
    lexical_consistency: '可以引導孩子不要看到「多」「少」就直接決定加減法，而是先想清楚題目描述的實際情境再動筆。',
    presentation_order: '可以引導孩子讀完整句敘述後，先把已知的數字寫下來、整理清楚，再決定怎麼計算。',
    distractor: '可以引導孩子先找出題目中真正需要用到的數字，練習忽略跟解題無關的描述。',
  };
  const REPORT_MIN_SAMPLES = 3;
  const RED_THRESHOLD = 50, YELLOW_THRESHOLD = 70;

  let bankPromise = null;
  function loadBank() {
    if (!bankPromise) {
      bankPromise = window.__realFetch('bank.jsonl')
        .then(r => { if (!r.ok) throw new Error('bank'); return r.text(); })
        .then(t => t.split('\n').filter(l => l.trim()).map(l => JSON.parse(l)));
    }
    return bankPromise;
  }

  const sessions = {};   // session_id -> { weights, used, questions }

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const pyStr = v => (v === true ? 'True' : v === false ? 'False' : String(v));
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }[c]));
  const normalize = s => (s || '').replace(/[ 　]/g, '').trim();

  function weightedPick(options, weights) {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < options.length; i++) { r -= weights[i]; if (r < 0) return options[i]; }
    return options[options.length - 1];
  }

  // adaptive.sample_params
  function sampleParams(sess) {
    const pick = name => weightedPick(OPTIONS[name], OPTIONS[name].map(o => {
      const w = (sess.weights[name] || {})[pyStr(o)];
      return w ? 1 + (1 - w.correct / (w.total || 1)) : 1;
    }));
    const presentation_order = pick('presentation_order');
    const operation = presentation_order ? pick('operation') : '減法';
    return {
      operation, number_type: '整數',
      carry_borrow: pick('carry_borrow'), nominalization: pick('nominalization'),
      lexical_consistency: pick('lexical_consistency'), presentation_order,
      question_placement: pick('question_placement'), distractor: pick('distractor'),
      response_mode: pick('response_mode'),
    };
  }

  // The bank holds one question per combination for a subset of all
  // combinations, so serve the unused question differing on the fewest
  // params (ties broken randomly). Weights are then updated with the
  // served question's own params, since those are what it actually tests.
  function closestQuestion(bank, sess, wanted) {
    let pool = bank.map((q, i) => i).filter(i => !sess.used.has(i));
    if (!pool.length) { sess.used.clear(); pool = bank.map((q, i) => i); }
    const mismatch = i => COMBO_KEYS.filter(k => bank[i].params[k] !== wanted[k]).length;
    const best = Math.min(...pool.map(mismatch));
    const ties = pool.filter(i => mismatch(i) === best);
    return ties[Math.floor(Math.random() * ties.length)];
  }

  // mc_options.build_mc_options
  function buildMcOptions(num1, num2, operation, unit, distractorNumber) {
    const correctValue  = operation === '加法' ? num1 + num2 : Math.abs(num1 - num2);
    const reversedValue = operation === '加法' ? Math.abs(num1 - num2) : num1 + num2;
    const taken = new Set(), cells = [];
    const add = (value, direction_correct, calc_correct, is_trap = false) => {
      let v = value <= 0 ? Math.abs(value) + 1 : value;
      while (taken.has(v)) v++;
      taken.add(v);
      cells.push({ value: v, direction_correct, calc_correct, is_trap, text: `${v}${unit}` });
    };
    add(correctValue, true, true);
    add(correctValue > SLIP ? correctValue - SLIP : correctValue + SLIP, true, false);
    add(reversedValue, false, true);
    add(reversedValue > SLIP ? reversedValue - SLIP : reversedValue + SLIP, false, false);
    if (distractorNumber !== null && distractorNumber !== undefined) {
      add(operation === '加法' ? correctValue + distractorNumber : correctValue - distractorNumber,
          null, null, true);
    }
    return shuffle(cells);
  }

  // parsing.extract_int, plus simple Chinese numerals ("三十六") since the
  // Gemini judge this replaces accepted those too.
  const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  function parseChinese(s) {
    const m = s.match(/[零〇一二兩三四五六七八九十百]+/);
    if (!m) return null;
    let total = 0, cur = 0;
    for (const ch of m[0]) {
      if (ch in CN_DIGITS) cur = CN_DIGITS[ch];
      else if (ch === '十') { total += (cur || 1) * 10; cur = 0; }
      else if (ch === '百') { total += (cur || 1) * 100; cur = 0; }
    }
    return total + cur;
  }
  function extractInt(s) {
    const d = (s || '').replace(/\D/g, '');
    return d ? parseInt(d, 10) : parseChinese(s || '');
  }

  function updateWeightSingle(sess, name, value, isCorrect) {
    const w = (sess.weights[name] ||= {});
    const cell = (w[value] ||= { correct: 0, total: 0 });
    cell.total++;
    if (isCorrect) cell.correct++;
  }

  // main._apply_diagnostic_weights
  function applyDiagnosticWeights(sess, p, matched, isCorrect) {
    if (!matched) {
      ['operation', 'carry_borrow', 'nominalization', 'lexical_consistency',
       'presentation_order', 'question_placement', 'distractor', 'response_mode']
        .forEach(k => updateWeightSingle(sess, k, pyStr(p[k]), isCorrect));
      return;
    }
    if (matched.is_trap) {
      updateWeightSingle(sess, 'distractor', p.distractor, false);
    } else {
      if (!p.lexical_consistency) updateWeightSingle(sess, 'lexical_consistency', 'False', matched.direction_correct);
      else if (!p.presentation_order) updateWeightSingle(sess, 'presentation_order', 'False', matched.direction_correct);
      updateWeightSingle(sess, 'operation', p.operation, matched.calc_correct);
      if (p.carry_borrow) updateWeightSingle(sess, 'carry_borrow', 'True', matched.calc_correct);
      if (p.distractor === 'numerical' || p.distractor === 'both') updateWeightSingle(sess, 'distractor', p.distractor, true);
    }
    updateWeightSingle(sess, 'nominalization', pyStr(p.nominalization), isCorrect);
    updateWeightSingle(sess, 'question_placement', p.question_placement, isCorrect);
    updateWeightSingle(sess, 'response_mode', p.response_mode, isCorrect);
  }

  function weaknessMap(sess) {
    const out = {};
    for (const [name, vals] of Object.entries(sess.weights)) {
      for (const [val, w] of Object.entries(vals)) {
        out[`${name}=${val}`] = Math.round(w.correct / (w.total || 1) * 1000) / 10;
      }
    }
    return out;
  }

  // ---- endpoint handlers (same request/response shapes as main.py) ----

  function createSession() {
    const id = uuid();
    sessions[id] = { weights: {}, used: new Set(), questions: {}, answered: 0, correct: 0 };
    return { session_id: id };
  }

  async function generateQuestion(body) {
    const sess = sessions[body.session_id];
    if (!sess) return [404, { detail: 'Session not found' }];
    const bank = await loadBank();
    const wanted = sampleParams(sess);
    const idx = closestQuestion(bank, sess, wanted);
    sess.used.add(idx);
    const q = bank[idx];
    const params = { ...q.params, number_type: '整數', response_mode: wanted.response_mode };
    const options = buildMcOptions(q.num1, q.num2, params.operation, q.unit, q.distractor_number);
    const isMc = params.response_mode === 'multiple_choice';
    const id = uuid();
    sess.questions[id] = { q, params, options, answered: false };
    return [200, {
      question_id: id, session_id: body.session_id, question_text: q.question_text,
      response_mode: params.response_mode, choices: isMc ? options.map(o => o.text) : null, params,
    }];
  }

  function submitAnswer(body) {
    const sess = sessions[body.session_id];
    const rec = sess && sess.questions[body.question_id];
    if (!rec) return [404, { detail: 'Question not found' }];
    if (rec.answered) return [400, { detail: 'Already answered' }];
    rec.answered = true;

    const { q, params, options } = rec;
    const correctOpt = options.find(o => o.direction_correct && o.calc_correct);
    const correctAnswer = correctOpt.text;
    let explanation = q.explanation;
    let isCorrect, missingUnit = false, matched;

    if (params.response_mode === 'multiple_choice') {
      const selected = normalize(body.student_answer);
      matched = options.find(o => normalize(o.text) === selected) || null;
      isCorrect = !!matched && !matched.is_trap && matched.direction_correct && matched.calc_correct;
    } else {
      const answer = normalize(body.student_answer);
      const value = extractInt(answer);
      isCorrect = value === correctOpt.value;
      // Right number but no (or a different) measure word: still counts as
      // correct, same as the Gemini judge's 「缺少單位」 verdict.
      missingUnit = isCorrect && !answer.includes(q.unit);
      matched = value === null ? null : (options.find(o => o.value === value) || null);
    }
    applyDiagnosticWeights(sess, params, matched, isCorrect);
    sess.answered++;
    if (isCorrect) sess.correct++;

    let feedback;
    if (missingUnit) {
      feedback = `數字答對了，很棒！別忘了加上單位喔，正確寫法：${correctAnswer}`;
      explanation = feedback;
    } else if (isCorrect) {
      feedback = `答對了！很棒！ 正確解法：${explanation}`;
    } else {
      if (matched && matched.is_trap) explanation = `題目裡有一個跟解題無關的數字，不用把它算進去喔！${explanation}`;
      feedback = `答錯了，再加油！ 正確解法：${explanation}`;
    }
    return [200, {
      is_correct: isCorrect, correct_answer: correctAnswer, feedback, explanation,
      missing_unit: missingUnit, updated_weights: weaknessMap(sess),
    }];
  }

  // main.get_stats, with fixed wording in place of the Gemini-written
  // praise/tip paragraphs.
  function stats(sessionId) {
    const sess = sessions[sessionId];
    if (!sess) return [404, { detail: 'Session not found' }];
    const weaknesses = [], strengths = [];
    for (const [name, vals] of Object.entries(sess.weights)) {
      for (const [val, w] of Object.entries(vals)) {
        const description = WEAKNESS_DESCRIPTIONS[`${name}=${val}`];
        if (!description || w.total < REPORT_MIN_SAMPLES) continue;
        const accuracy = Math.round(w.correct / w.total * 1000) / 10;
        const item = { name, description, accuracy };
        if (accuracy < YELLOW_THRESHOLD) {
          item.rank = accuracy < RED_THRESHOLD ? 0 : 1;
          weaknesses.push(item);
        } else {
          strengths.push(item);
        }
      }
    }
    weaknesses.sort((a, b) => a.rank - b.rank || a.accuracy - b.accuracy);
    strengths.sort((a, b) => b.accuracy - a.accuracy);

    const parts = [];
    if (strengths.length) {
      const list = strengths.map(s => `${s.description}（正確率 ${s.accuracy}%）`).join('、');
      parts.push(`<p>孩子在${escapeHtml(list)}表現得很穩定，值得好好鼓勵！</p>`);
    }
    for (const w of weaknesses) {
      parts.push(`<p>• <strong>${w.description}（正確率 ${w.accuracy}%）</strong>：${escapeHtml(WEAKNESS_TIPS[w.name] || '')}</p>`);
    }
    const parent_report = parts.length ? parts.join('') :
      '<p>這一輪練習累積的資料還不夠多，暫時看不出明顯的弱點模式，建議再多練習幾輪，系統才能更準確地抓出需要加強的地方。</p>';
    const total = sess.answered;
    return [200, {
      total_answered: total, correct: sess.correct,
      accuracy: total ? Math.round(sess.correct / total * 1000) / 10 : 0,
      parent_report,
    }];
  }

  // ---- fetch shim ----
  window.__realFetch = window.fetch.bind(window);
  const json = (status, data) => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });

  window.fetch = async function (input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    const path = new URL(url, location.href).pathname.replace(/^.*\/(?=session$|generate-question$|submit-answer$|stats\/)/, '/');
    const body = init.body ? JSON.parse(init.body) : {};
    try {
      if (path === '/session') return json(200, createSession());
      if (path === '/generate-question') return json(...await generateQuestion(body));
      if (path === '/submit-answer') return json(...submitAnswer(body));
      if (path.startsWith('/stats/')) return json(...stats(decodeURIComponent(path.slice(7))));
    } catch (e) {
      console.error(e);
      return json(500, { detail: '系統暫時出錯，請重新整理頁面' });
    }
    return window.__realFetch(input, init);
  };
})();
