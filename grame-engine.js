(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GrameEngine = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Grame 文法エンジン (NFA + 意味制約 + 節単位有生性チェック)
   * ブラウザ・Node.js 両対応の UMD モジュール
   */

  const VCLASS = {
    VEAT:   { b: 'E', sem: ['S_FOOD', 'S_DRINK', 'S_MED'], ja: '食べ物・飲み物・薬' },
    VDRINK: { b: 'D', sem: ['S_DRINK'], ja: '飲み物' },
    VWATCH: {
      b: 'W',
      sem: [
        'S_ANIMATE', 'S_FOOD', 'S_DRINK', 'S_PLACE', 'S_THING', 'S_MEDIA',
        'S_CLOTH', 'S_VEHICLE', 'S_PLANT', 'S_COMM', 'S_LEARN', 'S_NATURE', 'S_MONEY',
      ],
      ja: '見られるもの',
    },
    VREAD:  { b: 'R', sem: ['S_MEDIA', 'S_LEARN'], ja: '読むもの（本・記事など）' },
    VLISTEN:{ b: 'U', sem: ['S_AUDIO', 'S_LEARN'], ja: '聞くもの（音楽・語学など）' },
    VLEARN: { b: 'G', sem: ['S_LEARN'], ja: '学ぶ内容', viObject: true },
    VWEAR:  { b: 'C', sem: ['S_CLOTH'], ja: '衣類' },
    VOPEN:  { b: 'Y', sem: ['S_VEHICLE', 'S_THING'], ja: '開ける・乗るもの' },
    VCALL:  { b: 'K', sem: ['S_COMM'], ja: '電話' },
    VPLANT: { b: 'F', sem: ['S_PLANT'], ja: '植物・果物' },
    VRAISE: { b: 'A', sem: ['S_ANIMATE', 'S_PLANT'], ja: '生き物・植物' },
    VTEACH: { b: 'H', sem: ['S_LEARN', 'S_ANIMATE'], ja: '教える内容または相手' },
    VTELL:  { b: 'J', sem: ['S_ANIMATE'], ja: '相手（人・動物）' },
  };

  const AGENTIVE = new Set(['VT', 'VC', 'VI', 'MODAL', ...Object.keys(VCLASS)]);

  const CATEGORY_DEFS = [
    { id: 'pron', label: '代詞・指示', test: tags => tags.some(t => t === 'PRON' || t === 'DEM' || t === 'QPRON') },
    { id: 'time', label: '時間', test: tags => tags.includes('TIME') },
    { id: 'num',  label: '数詞・量詞', test: tags => tags.some(t => t === 'NUM' || t === 'MW' || t === 'SUI') },
    { id: 'noun_anim', label: '人・生き物', test: tags => tags.includes('NOUN') && tags.includes('S_ANIMATE') },
    { id: 'noun_food', label: '食・飲', test: tags => tags.includes('NOUN') && (tags.includes('S_FOOD') || tags.includes('S_DRINK') || tags.includes('S_MED')) },
    { id: 'noun_place', label: '場所', test: tags => tags.includes('NOUN') && tags.includes('S_PLACE') },
    { id: 'noun_other', label: 'モノ・学習・抽象', test: tags => tags.includes('NOUN') && !tags.includes('S_ANIMATE') && !tags.includes('S_FOOD') && !tags.includes('S_DRINK') && !tags.includes('S_MED') && !tags.includes('S_PLACE') },
    { id: 'verb', label: '動詞・是・有', test: tags => tags.some(t => t === 'VT' || t === 'VC' || t === 'VI' || t === 'SHI' || t === 'YOU' || VCLASS[t]) },
    { id: 'adj',  label: '形容詞', test: tags => tags.includes('ADJ') },
    { id: 'adv',  label: '副詞・助動詞・否定', test: tags => tags.some(t => t === 'ADV' || t === 'DEG_ADV' || t === 'BI_ADV' || t === 'MODAL' || t === 'NEG0' || t === 'NEG1' || t === 'NEG2') },
    { id: 'prep', label: '介詞（前置詞）', test: tags => tags.some(t => t.startsWith('PREP_')) },
    { id: 'part', label: '助詞・接続詞', test: tags => tags.some(t => t === 'DE' || t === 'LE' || t === 'EXP' || t === 'FP' || t === 'CONJ' || t === 'CLCONJ') },
  ];

  function parseLexicon(csv) {
    const lex = {};
    const sem = {};
    const rawTags = {};
    for (const line of String(csv || '').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.startsWith('word,')) continue;
      const parts = t.split(',');
      if (parts.length < 2) continue;
      const w = parts[0].trim();
      const tags = parts[1].split('|').map(s => s.trim()).filter(Boolean);
      const sems = (parts[2] || '').split('|').map(s => s.trim()).filter(Boolean);
      if (!w || !tags.length) continue;
      rawTags[w] = tags;
      lex[w] = tags.concat(sems.map(s => 'S_' + s));
      if (sems.length) sem[w] = sems;
    }
    return { lex, sem, rawTags };
  }

  function buildGrammar(lexicon) {
    const ACCEPTING = new Set(['COMPLETE', 'COMPLETE2', 'FINAL', 'VI', 'EXP']);
    const T = {};
    const put = (s, tag, next) => {
      const m = (T[s] = T[s] || {});
      const arr = (m[tag] = m[tag] || []);
      for (const n of [].concat(next)) if (!arr.includes(n)) arr.push(n);
    };
    const copyInto = (dst, srcState) => {
      for (const [tag, n] of Object.entries(T[srcState] || {})) put(dst, tag, n);
    };

    function buildNP(P, outer, accepting, nounTags, options) {
      const NT = nounTags || ['NOUN'];
      const isGeneral = NT.includes('NOUN');
      const allowPron = options && options.allowPron !== undefined ? options.allowPron : isGeneral;
      const allowDem = options && options.allowDem !== undefined ? options.allowDem : isGeneral;
      const allowTime = options && options.allowTime !== undefined ? options.allowTime : isGeneral;
      const allowQPron = options && options.allowQPron !== undefined ? options.allowQPron : true;
      const acceptDE = Boolean(options && options.acceptDE);

      const putN = (s, next) => { for (const t of NT) put(s, t, next); };

      if (allowPron) {
        put(P + '0', 'PRON', P + 'OK');
      } else {
        // 限定名詞句でも「我的房间」「你的苹果」のような所有修飾は許可
        put(P + '0', 'PRON', P + 'POSS');
        put(P + 'POSS', 'DE', P + 'DE');
      }

      if (allowDem) {
        put(P + '0', 'DEM', [P + 'DEM', P + 'OK']);
      } else {
        put(P + '0', 'DEM', P + 'DEM');
      }

      if (allowQPron) put(P + '0', 'QPRON', P + 'OK');
      if (allowTime) put(P + '0', 'TIME', P + 'OK');

      put(P + '0', 'NUM', P + 'NUM');
      putN(P + '0', P + 'OK');
      put(P + '0', 'ADJ', P + 'ADJ');

      put(P + 'DEM', 'MW', P + 'DEMM');
      putN(P + 'DEMM', P + 'OK');
      put(P + 'DEMM', 'ADJ', P + 'ADJ');

      put(P + 'NUM', 'MW', P + 'NUMM');
      put(P + 'NUM', 'SUI', P + 'SUI');
      put(P + 'SUI', 'DE', P + 'DE');
      putN(P + 'NUMM', P + 'OK');
      put(P + 'NUMM', 'ADJ', P + 'ADJ');

      putN(P + 'ADJ', P + 'OK');
      put(P + 'ADJ', 'DE', P + 'ADJDE');
      putN(P + 'ADJDE', P + 'OK');
      put(P + 'ADJDE', 'ADJ', P + 'ADJ');
      put(P + 'ADJDE', 'NUM', P + 'NUM');

      putN(P + 'DE', P + 'OK');
      put(P + 'DE', 'ADJ', P + 'ADJ');
      put(P + 'DE', 'NUM', P + 'NUM');

      put(P + 'OK', 'DE', P + 'DE');
      put(P + 'OK', 'CONJ', P + '0');

      for (const [tag, next] of Object.entries(outer)) {
        put(P + 'OK', tag, next);
        if (acceptDE) put(P + 'DE', tag, next);
        if (accepting) put(P + 'ADJDE', tag, next);
      }

      if (accepting) {
        ACCEPTING.add(P + 'OK');
        ACCEPTING.add(P + 'ADJDE'); // 「我买大的」「这是新的」など形容詞の名詞化
        if (acceptDE) ACCEPTING.add(P + 'DE'); // 「我是学生的」「这是我的」など
      }
    }

    const completeOuter = {
      FP: ['FINAL'],
      LE: ['COMPLETE2'],
      CLCONJ: ['CLAUSE'],
      PREP_ZAI: ['ZAI0'],
    };

    const classEntries = {};
    for (const tag of Object.keys(VCLASS)) classEntries[tag] = ['Q' + tag];

    const predOuter = {
      ADV: ['PRED'],
      DEG_ADV: ['DEGZONE'],
      MODAL: ['VZONE'],
      NEG0: ['NEGP0'],
      NEG1: ['NEGP'],
      NEG2: ['PREDN'],
      NUM: ['AGE'],
      SHI: ['H0'],
      YOU: ['O0'],
      VT: ['VT'],
      VC: ['VC'],
      VI: ['VI'],
      ADJ: ['COMPLETE'],
      ...classEntries,
    };

    const subjOuter = {
      TIME: ['SUBJ'],
      PREP_ZAI: ['ZAI0'],
      PREP_BI: ['BI0'],
      PREP_DIR: ['DIR0'],
      PREP_REL: ['REL0'],
      ...predOuter,
    };

    // 主語名詞句
    buildNP('S', subjOuter, false, ['NOUN'], { acceptDE: false });
    // 一般目的語（有・他動詞・VC）
    buildNP('O', completeOuter, true, ['NOUN'], { acceptDE: false });
    // 「是」の目的語（「我是学生的」「这是我的」を完成と認める）
    buildNP('H', completeOuter, true, ['NOUN'], { acceptDE: true });
    // 「在」の目的語（場所のみ。そのまま完成 or 後続述語）
    buildNP('ZAI', Object.assign({}, predOuter, completeOuter), true, ['S_PLACE'], {
      allowPron: false,
      allowDem: false,
      allowTime: false,
      allowQPron: false,
      acceptDE: false,
    });
    // 「比」の比較対象（形容詞述語へ）
    buildNP('BI', { ADJ: ['COMPLETE'], BI_ADV: ['BIADV'] }, false, ['NOUN'], { acceptDE: true });
    put('BIADV', 'ADJ', 'COMPLETE');
    put('BIADV', 'BI_ADV', 'BIADV');
    // 「从 / 到」の対象（場所または時間 → 述語へ）
    buildNP('DIR', predOuter, false, ['S_PLACE'], {
      allowPron: false,
      allowDem: false,
      allowTime: true,
      allowQPron: false,
    });
    // 「跟 / 为 / 向 / 给 / 对」の対象（名詞句 → 述語へ）
    buildNP('REL', predOuter, false, ['NOUN'], { acceptDE: false });
    // 自動詞の行き先（場所のみ）
    buildNP('L', Object.assign({}, predOuter, completeOuter), true, ['S_PLACE'], {
      allowPron: false,
      allowDem: false,
      allowTime: false,
      allowQPron: false,
      acceptDE: false,
    });

    for (const [tag, vc] of Object.entries(VCLASS)) {
      buildNP(vc.b, completeOuter, true, vc.sem, {
        allowPron: false,
        allowDem: false,
        allowTime: false,
        allowQPron: true,
        acceptDE: false,
      });
      if (vc.viObject) put(vc.b + '0', 'VI', vc.b + 'OK'); // 「学游泳」
    }

    // 文頭
    put('START', 'TIME', 'STARTT');
    put('START', 'CLCONJ', 'CLAUSE');
    copyInto('START', 'S0');
    copyInto('STARTT', 'S0');
    put('STARTT', 'TIME', 'STARTT');

    // 程度副詞ゾーン（很 / 非常 / 太 / 真 / 特别）: 形容詞・心理動詞・助動詞のみ
    put('DEGZONE', 'ADJ', 'COMPLETE');
    put('DEGZONE', 'MENTAL', 'VC');
    put('DEGZONE', 'MODAL', 'VZONE');

    // 否定の後:
    // 不 (NEGP0): 是・形容詞・助動詞・心理/一般動詞OK, 有NG
    put('NEGP0', 'ADV', 'NEGP0');
    put('NEGP0', 'DEG_ADV', 'DEGZONE');
    put('NEGP0', 'MODAL', 'VZONE');
    put('NEGP0', 'SHI', 'H0');
    put('NEGP0', 'VT', 'VT');
    put('NEGP0', 'VC', 'VC');
    put('NEGP0', 'VI', 'VI');
    put('NEGP0', 'ADJ', 'COMPLETE');

    // 没 (NEGP): 有(または無目的語「没钱」)OK・動作動詞OK・是NG・形容詞NG
    put('NEGP', 'ADV', 'NEGP');
    put('NEGP', 'MODAL', 'VZONE');
    put('NEGP', 'YOU', 'O0');
    put('NEGP', 'VT', 'VT');
    put('NEGP', 'VC', 'VC');
    put('NEGP', 'VI', 'VI');
    copyInto('NEGP', 'O0');

    // 没有 (PREDN): 動詞否定。是・有・形容詞NG
    put('PREDN', 'ADV', 'PREDN');
    put('PREDN', 'MODAL', 'VZONE');
    put('PREDN', 'VT', 'VT');
    put('PREDN', 'VC', 'VC');
    put('PREDN', 'VI', 'VI');

    // 年齢述語: 数詞 -> 岁 で完成
    put('AGE', 'SUI', 'COMPLETE');

    // 経験の「过」
    copyInto('EXP', 'O0');
    for (const [tag, n] of Object.entries(completeOuter)) put('EXP', tag, n);

    // 意味クラス動詞の状態
    for (const [tag, vc] of Object.entries(VCLASS)) {
      const st = 'Q' + tag;
      put(st, 'LE', 'COMPLETE');
      put(st, 'EXP', 'EXP');
      put(st, 'PREP_ZAI', 'ZAI0');
      copyInto(st, vc.b + '0');
      put('VZONE', tag, st);
      put('NEGP0', tag, st);
      put('NEGP', tag, st);
      put('PREDN', tag, st);
    }

    // 主語の後 / 述語ゾーン
    for (const [tag, n] of Object.entries(subjOuter)) put('SUBJ', tag, n);
    for (const [tag, n] of Object.entries(predOuter)) put('PRED', tag, n);

    // 助動詞の後
    put('VZONE', 'VT', 'VT');
    put('VZONE', 'VI', 'VI');
    put('VZONE', 'VC', 'VC');
    put('VZONE', 'SHI', 'H0');
    put('VZONE', 'YOU', 'O0');
    put('VZONE', 'ADV', 'VZONE');

    // 他動詞の後
    put('VT', 'LE', 'COMPLETE');
    put('VT', 'EXP', 'EXP');
    copyInto('VT', 'O0');
    put('VT', 'PREP_ZAI', 'ZAI0');

    // 自動詞の後
    put('VI', 'EXP', 'EXP');
    copyInto('VI', 'L0');
    for (const [tag, n] of Object.entries(completeOuter)) put('VI', tag, n);

    // 節の接続後
    copyInto('CLAUSE', 'START');
    for (const [tag, n] of Object.entries(predOuter)) put('CLAUSE', tag, n);

    // 動詞句・節を取る動詞の後 (喜欢/爱/希望/需要)
    copyInto('VC', 'O0');
    copyInto('VC', 'CLAUSE');

    // 完成後の「了」は1回まで
    for (const [tag, n] of Object.entries(completeOuter)) {
      if (tag !== 'LE') put('COMPLETE2', tag, n);
    }
    for (const [tag, n] of Object.entries(completeOuter)) put('COMPLETE', tag, n);

    // 事前インデックス化（タグ -> 語リスト）
    const ALL_TAGS = new Set(Object.values(lexicon).flat());
    const STATE_EXTENDABLE = {};
    for (const [s, m] of Object.entries(T)) {
      STATE_EXTENDABLE[s] = Object.keys(m).some(t => ALL_TAGS.has(t));
    }

    const TAG_TO_WORDS = {};
    for (const [w, tags] of Object.entries(lexicon)) {
      for (const t of tags) {
        if (!TAG_TO_WORDS[t]) TAG_TO_WORDS[t] = [];
        TAG_TO_WORDS[t].push(w);
      }
    }

    return { ACCEPTING, TRANSITIONS: T, STATE_EXTENDABLE, TAG_TO_WORDS };
  }

  function createEngine(csvText) {
    const { lex: LEXICON, sem: SEM, rawTags: RAW_TAGS } = parseLexicon(csvText);
    const { ACCEPTING, TRANSITIONS, STATE_EXTENDABLE, TAG_TO_WORDS } = buildGrammar(LEXICON);

    const BUILDER_JA = {};
    for (const vc of Object.values(VCLASS)) BUILDER_JA[vc.b] = vc.ja;

    function phaseName(states) {
      if (states.some(x => x === 'START' || x === 'STARTT' || x === 'CLAUSE' || x.startsWith('S'))) return '主語（名詞句）';
      if (states.some(x => x === 'SUBJ' || x === 'PRED')) return '述語（動詞・形容詞・是など）';
      if (states.some(x => x === 'NEGP0' || x === 'NEGP' || x === 'PREDN')) return '述語（動詞・形容詞）';
      if (states.some(x => x === 'DEGZONE')) return '形容詞・心理動詞';
      if (states.some(x => x === 'VZONE')) return '動詞';
      if (states.some(x => x === 'BI0' || x === 'BIOK')) return '比較の対象または形容詞';
      if (states.some(x => x === 'BIADV')) return '形容詞';
      if (states.some(x => x === 'ZAI0' || x === 'ZAIOK')) return '場所の名詞または述語';
      if (states.some(x => x.startsWith('DIR'))) return '場所・時間の名詞';
      if (states.some(x => x.startsWith('REL'))) return '相手・対象の名詞句';
      if (states.some(x => x === 'VT' || x.startsWith('O') || x.startsWith('H'))) return '目的語（名詞句）';
      if (states.some(x => ACCEPTING.has(x))) return '完成した文の続き（助詞・接続詞など）';
      return '次の語';
    }

    function slotHint(states) {
      for (const x of states) {
        if (x.startsWith('Q') && VCLASS[x.slice(1)]) return VCLASS[x.slice(1)].ja;
        if (BUILDER_JA[x[0]] && ['0', 'OK', 'DE', 'POSS', 'NUM', 'NUMM', 'DEM', 'DEMM', 'ADJ', 'ADJDE'].includes(x.slice(1))) {
          return BUILDER_JA[x[0]];
        }
        if (x[0] === 'L' && ['0', 'OK', 'DE', 'POSS', 'NUM', 'NUMM', 'DEM', 'DEMM', 'ADJ', 'ADJDE'].includes(x.slice(1))) {
          return '場所の名詞';
        }
      }
      if (states.some(x => x.endsWith('NUM'))) return '量詞（个・只・本など）または「岁」';
      if (states.some(x => x.endsWith('NUMM') || x.endsWith('DEMM'))) return '名詞';
      if (states.some(x => x.endsWith('DEM'))) return '量詞';
      if (states.some(x => x.endsWith('POSS'))) return '「的」';
      if (states.some(x => x.endsWith('ADJ'))) return '名詞か「的」';
      if (states.some(x => x.endsWith('DE') || x.endsWith('ADJDE'))) return '名詞';
      return phaseName(states);
    }

    function stepStates(states, w) {
      const tags = LEXICON[w];
      if (!tags) return null;
      const next = new Set();
      for (const st of states) {
        const tr = TRANSITIONS[st] || {};
        for (const tag of tags) {
          const targets = tr[tag];
          if (targets) for (let i = 0; i < targets.length; i++) next.add(targets[i]);
        }
      }
      return next.size ? [...next] : null;
    }

    function evalStates(states) {
      return {
        complete: states.some(s => ACCEPTING.has(s)),
        extendable: states.some(s => STATE_EXTENDABLE[s]),
      };
    }

    const analyzeCache = new Map();
    const inSubjPhase = ss => ss.some(s => s === 'START' || s === 'STARTT' || s === 'CLAUSE' || s.startsWith('S'));

    function analyze(words) {
      const key = words.join('\u0001');
      if (analyzeCache.has(key)) return analyzeCache.get(key);

      let states = ['START'];
      let result = null;
      let subjHead = null;
      let subjClosed = false;
      let animacyChecked = false;
      let clauseMei = false;

      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const tags = LEXICON[w];
        if (!tags) {
          result = {
            valid: false,
            complete: false,
            extendable: false,
            reason: `「${w}」は辞書にない語（収録語彙 ${Object.keys(LEXICON).length} 語の範囲で判定）`,
          };
          break;
        }

        // 節接続詞 (CLCONJ) が来たら節単位の状態をリセット
        if (tags.includes('CLCONJ') && states.some(s => (TRANSITIONS[s] && TRANSITIONS[s].CLCONJ))) {
          subjHead = null;
          subjClosed = false;
          animacyChecked = false;
          clauseMei = false;
        }

        // 没 / 没有 の後の「了」を禁止（「没有钱了」のように「没有」が「有」の否定で名詞目的語を取る場合は除外）
        if (tags.includes('NEG1')) {
          clauseMei = true;
        } else if (tags.includes('NEG2') && states.some(s => TRANSITIONS[s] && TRANSITIONS[s].NEG2)) {
          // 次の語が動詞相当ならNEG2として「了」禁止（ただし「没有+名詞」はYOUとして許可）
          const nextW = words[i + 1];
          if (nextW && LEXICON[nextW] && LEXICON[nextW].some(t => AGENTIVE.has(t) || t === 'ADV')) {
            clauseMei = true;
          }
        }

        if (clauseMei && tags.includes('LE') && !tags.includes('CLCONJ')) {
          result = {
            valid: false,
            complete: false,
            extendable: false,
            reason: '「没／没有」で否定した動詞の後ろに「了」は付けられない',
          };
          break;
        }

        if (!subjClosed && inSubjPhase(states)) {
          if (SEM[w]) {
            subjHead = { word: w, sems: SEM[w] };
          } else if (tags.includes('DEM') || tags.includes('QPRON')) {
            subjHead = { word: w, sems: [] };
          }
        }

        const next = stepStates(states, w);
        if (!next) {
          result = {
            valid: false,
            complete: false,
            extendable: false,
            reason: `「${w}」はこの位置に置けない。今は「${slotHint(states)}」を待っている`,
          };
          break;
        }

        if (!subjClosed && !inSubjPhase(next)) subjClosed = true;

        if (subjClosed && !animacyChecked && w !== '下雨' && tags.some(t => AGENTIVE.has(t))) {
          animacyChecked = true;
          if (subjHead && !subjHead.sems.includes('ANIMATE')) {
            result = {
              valid: false,
              complete: false,
              extendable: false,
              reason: `「${subjHead.word}」は生き物ではないため、「${w}」の主語にはなれない`,
            };
            break;
          }
        }

        states = next;
      }

      if (!result) {
        const ev = evalStates(states);
        result = {
          valid: true,
          complete: ev.complete,
          extendable: ev.extendable,
          states,
          hint: slotHint(states),
        };
      }

      if (analyzeCache.size > 5000) analyzeCache.clear();
      analyzeCache.set(key, result);
      return result;
    }

    function candidateWordsFromStates(states) {
      const seen = new Set();
      for (const st of states) {
        const tr = TRANSITIONS[st];
        if (!tr) continue;
        for (const tag of Object.keys(tr)) {
          const ws = TAG_TO_WORDS[tag];
          if (ws) for (let i = 0; i < ws.length; i++) seen.add(ws[i]);
        }
      }
      return [...seen];
    }

    function legalMoves(words) {
      const base = analyze(words);
      if (!base.valid) return [];
      const candidates = candidateWordsFromStates(base.states);
      const out = [];
      for (let i = 0; i < candidates.length; i++) {
        const w = candidates[i];
        const r = analyze(words.concat(w));
        if (r.valid) {
          out.push({
            word: w,
            complete: r.complete,
            extendable: r.extendable,
            states: r.states,
          });
        }
      }
      return out;
    }

    function aiChoose(words) {
      const moves = legalMoves(words);
      if (!moves.length) return null;

      // 1手勝ち（自分が完成させて相手が一切続けられない手）があれば最優先
      const instantWin = moves.filter(m => m.complete && !m.extendable);
      if (instantWin.length) return instantWin[Math.floor(Math.random() * instantWin.length)].word;

      // 相手が次手で1手勝ちできない安全な手をフィルタ
      const safe = moves.filter(m => {
        const nextWords = words.concat(m.word);
        const nextCandidates = candidateWordsFromStates(m.states);
        for (let i = 0; i < nextCandidates.length; i++) {
          const r2 = analyze(nextWords.concat(nextCandidates[i]));
          if (r2.valid && r2.complete && !r2.extendable) return false;
        }
        return true;
      });

      let pool = safe.length ? safe : moves;

      // 同じ語の繰り返しや「的」「和」「副詞」の過度な連続を抑制
      const wordCounts = {};
      for (const w of words) wordCounts[w] = (wordCounts[w] || 0) + 1;
      const nonRepeat = pool.filter(m => (wordCounts[m.word] || 0) < 1);
      if (nonRepeat.length) pool = nonRepeat;

      const lastWord = words[words.length - 1];
      if (lastWord && (LEXICON[lastWord].includes('ADV') || LEXICON[lastWord].includes('CLCONJ'))) {
        const nonAdv = pool.filter(m => !LEXICON[m.word].includes('ADV'));
        if (nonAdv.length) pool = nonAdv;
      }

      if (words.length >= 5) {
        const nonAdv = pool.filter(m => !LEXICON[m.word].includes('ADV') && !LEXICON[m.word].includes('DEG_ADV'));
        if (nonAdv.length) pool = nonAdv;
      }

      const finishing = pool.filter(m => m.complete);
      const shouldFinish = finishing.length && (words.length >= 7 || Math.random() < 0.45);
      const pickFrom = shouldFinish ? finishing : pool;
      return pickFrom[Math.floor(Math.random() * pickFrom.length)].word;
    }

    function getCategoryForWord(word) {
      const tags = LEXICON[word] || [];
      for (const def of CATEGORY_DEFS) {
        if (def.test(tags)) return def;
      }
      return CATEGORY_DEFS[CATEGORY_DEFS.length - 1];
    }

    function getLexiconByCategory() {
      const groups = CATEGORY_DEFS.map(d => ({ id: d.id, label: d.label, words: [] }));
      const byId = Object.fromEntries(groups.map(g => [g.id, g]));
      for (const w of Object.keys(LEXICON)) {
        const cat = getCategoryForWord(w);
        byId[cat.id].words.push({
          word: w,
          tags: RAW_TAGS[w] || [],
          sems: SEM[w] || [],
        });
      }
      return groups.filter(g => g.words.length > 0);
    }

    return {
      LEXICON,
      SEM,
      RAW_TAGS,
      VCLASS,
      CATEGORY_DEFS,
      wordCount: Object.keys(LEXICON).length,
      analyze,
      legalMoves,
      aiChoose,
      slotHint,
      getCategoryForWord,
      getLexiconByCategory,
    };
  }

  return { createEngine, parseLexicon, VCLASS, CATEGORY_DEFS };
}));
