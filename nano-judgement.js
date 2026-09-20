/**
 * nano-judgement.js
 * 
 * Chrome の組み込み AI (Gemini Nano / Prompt API) を操作して、
 * 入力された複数の選択肢の中から最も可能性・妥当性が高いものを判断・推論するライブラリです。
 * 
 * - 出力速度を最速にするため、デフォルトでは選択肢の確率（確信度）のみを判定・出力します。
 * - 理由が必要な場合（includeReason: true / data-judge-reason="true"）のみ理由を生成し、
 *   Chrome の Translator API (window.translation / ai.translator) で入力言語に翻訳して出力します。
 * - 5文字以上のテキスト入力時、Language Detector API と Translator API を使って英語に事前翻訳・キャッシュ。
 * - バックグラウンド事前判定を開始し、2秒以内の再更新キャッシュ分離、および2秒経過後/経過時における25%以上のテキスト変更時の判定中断＆再判定に対応。
 */

/**
 * @typedef {Object} Choice
 * @property {string} id - 選択肢の一意なID
 * @property {string} name - 選択肢の名称
 * @property {string} [description] - 選択肢の詳細説明・特徴
 * @property {Record<string, any>} [metadata] - 付加情報
 */

/**
 * @typedef {Object} RankedChoice
 * @property {string} id - 選択肢ID
 * @property {string} name - 選択肢名
 * @property {number} confidence - 確信度 / 可能性 (0.0 〜 1.0)
 * @property {string} [reason] - 判定理由（includeReason有効時のみ）
 */

/**
 * @typedef {Object} JudgementResult
 * @property {Choice} topChoice - 最も可能性が高いと判断された選択肢
 * @property {RankedChoice[]} rankings - 全選択肢の順位・評価
 * @property {string} [summaryReason] - 全体的な判断サマリー（includeReason有効時のみ）
 * @property {string} rawResponse - Prompt API からの生の応答テキスト
 * @property {boolean} [fromCache] - キャッシュからの取得かどうか
 */

export class NanoJudgement {
  /**
   * @param {Object} [options]
   * @param {number} [options.temperature=0.2] - 生成温度
   * @param {number} [options.topK=3]
   * @param {string} [options.systemPrompt] - カスタムシステムプロンプト
   * @param {boolean} [options.includeReason=false] - 理由を出力するかどうか（デフォルトは速度優先のためfalse）
   * @param {boolean} [options.enableCache=true] - 判定結果をキャッシュするかどうか
   * @param {'memory'|'session'|'local'} [options.cacheStorage='session'] - キャッシュの保存先
   * @param {Choice[]} [options.defaultChoices] - デフォルトの選択肢リスト
   * @param {boolean} [options.autoScan=true] - 読み込み時に data-nano-judgement 要素を自動スキャン・監視するか
   */
  constructor(options = {}) {
    this.options = {
      temperature: 0.2,
      topK: 3,
      includeReason: false,
      enableCache: true,
      cacheStorage: 'session',
      maxCacheGenerations: 1000,
      defaultChoices: [],
      autoScan: true,
      ...options,
    };
    this.session = null;
    this.memoryCache = new Map();
    // 各入力要素ごとのバックグラウンド判定・変更監視状態
    this.elementSessions = new WeakMap();

    if (this.options.autoScan && typeof window !== "undefined") {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => this.scanAndJudge());
      } else {
        setTimeout(() => this.scanAndJudge(), 0);
      }
    }
  }

  /**
   * 実行環境の LanguageModel API オブジェクトを取得
   * @returns {any}
   */
  getLanguageModelAPI() {
    if (typeof window !== "undefined") {
      if (window.LanguageModel) return window.LanguageModel;
      if (window.ai?.languageModel) return window.ai.languageModel;
    }
    if (typeof globalThis !== "undefined") {
      if (globalThis.LanguageModel) return globalThis.LanguageModel;
      if (globalThis.ai?.languageModel) return globalThis.ai.languageModel;
    }
    return undefined;
  }

  /**
   * Chrome の Prompt API が利用可能か確認する
   * @param {number} [timeoutMs=5000] - タイムアウト時間（ミリ秒）
   * @returns {Promise<{ available: boolean, status: string, message: string }>}
   */
  async checkAvailability(timeoutMs = 5000) {
    const languageModel = this.getLanguageModelAPI();

    if (!languageModel) {
      return {
        available: false,
        status: "no_api",
        message: "Chrome Prompt API (window.LanguageModel または window.ai.languageModel) が見つかりません。最新の Chrome で chrome://flags/#prompt-api-for-gemini-nano を有効にしてください。",
      };
    }

    try {
      const checkPromise = (async () => {
        let status = "unknown";
        if (typeof languageModel.availability === "function") {
          status = await languageModel.availability();
        } else if (typeof languageModel.capabilities === "function") {
          const caps = await languageModel.capabilities();
          status = caps?.available || "unknown";
        }
        return status;
      })();

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Prompt API の応答がタイムアウトしました")), timeoutMs)
      );

      const rawStatus = await Promise.race([checkPromise, timeoutPromise]);
      const status = String(rawStatus).toLowerCase();

      if (["readily", "available", "readily-available"].includes(status)) {
        return {
          available: true,
          status,
          message: "Prompt API (Gemini Nano) はすぐに利用可能です。",
        };
      } else if (["after-download", "downloadable", "downloading"].includes(status)) {
        return {
          available: true,
          status,
          message: `Gemini Nano モデルのダウンロードが必要です (ステータス: ${status})。chrome://components で確認してください。`,
        };
      } else {
        return {
          available: false,
          status,
          message: `Prompt API は現在利用できません (Status: ${status})`,
        };
      }
    } catch (err) {
      return {
        available: false,
        status: "error",
        message: `API 状態確認中にエラーが発生しました: ${err.message}`,
      };
    }
  }

  /**
   * Language Detector API を使ってテキストの言語を検出する
   * @param {string} text 
   * @returns {Promise<string>} 言語コード（例: 'ja', 'en'）
   */
  async detectLanguage(text) {
    if (typeof text !== 'string' || !text.trim()) return 'ja';

    try {
      const globalObj = typeof window !== 'undefined' ? window : globalThis;
      let detector = null;

      if (typeof globalObj.translation !== 'undefined' && typeof globalObj.translation.createDetector === 'function') {
        detector = await globalObj.translation.createDetector();
      } else if (globalObj.ai?.languageDetector?.create) {
        detector = await globalObj.ai.languageDetector.create();
      }

      if (detector && typeof detector.detect === 'function') {
        const results = await detector.detect(text);
        if (results && results.length > 0 && results[0].detectedLanguage) {
          return results[0].detectedLanguage;
        }
      }
    } catch (e) {
      console.warn('Language Detector API error, falling back:', e);
    }

    // フォールバック（日本語文字チェック）
    if (/[ぁ-んァ-ヶ一-龠々]/.test(text)) {
      return 'ja';
    }
    return 'en';
  }

  /**
   * テキストを指定言語に翻訳（Chrome Translator API を使用）
   * @param {string} text - 翻訳するテキスト
   * @param {string} targetLang - 翻訳先言語コード（例: 'en', 'ja'）
   * @param {string} [sourceLang='en'] - 原文言語コード
   * @returns {Promise<string>} 翻訳後のテキスト
   */
  async translateText(text, targetLang, sourceLang = 'en') {
    if (!text || targetLang === sourceLang) return text;

    try {
      const globalObj = typeof window !== 'undefined' ? window : globalThis;
      let translator = null;

      if (typeof globalObj.translation !== 'undefined' && typeof globalObj.translation.createTranslator === 'function') {
        translator = await globalObj.translation.createTranslator({
          sourceLanguage: sourceLang,
          targetLanguage: targetLang,
        });
      } else if (globalObj.ai?.translator && typeof globalObj.ai.translator.create === 'function') {
        translator = await globalObj.ai.translator.create({
          sourceLanguage: sourceLang,
          targetLanguage: targetLang,
        });
      }

      if (translator && typeof translator.translate === 'function') {
        return await translator.translate(text);
      }
    } catch (e) {
      console.warn('Translator API での翻訳に失敗したため、原文を維持します:', e);
    }

    return text;
  }

  /**
   * キャッシュ保存・判定用にテキストからスペース（空白文字）や句読点・約物を省いて正規化する
   * @param {string} text 
   * @returns {string}
   */
  normalizeTextForCache(text) {
    if (typeof text !== "string") return "";
    return text.replace(/[\s\u3000\u3001\u3002\uFF0C\uFF0E\uFF01\uFF1F\u30FB\u2026,;.!?！？・…]+/g, "");
  }

  /**
   * 入力内容を Language Detector と Translator API を使って英語に翻訳し、
   * その翻訳文を個別にキャッシュする
   * @param {string} text 
   * @returns {Promise<{ translatedText: string, sourceLang: string }>}
   */
  async translateAndCacheEnglish(text) {
    const trimmed = text.trim();
    const normalizedKey = this.normalizeTextForCache(trimmed);
    const sourceLang = await this.detectLanguage(trimmed);

    // 既に英語の場合はそのままキャッシュ
    if (sourceLang === 'en') {
      const cacheKey = `trans_en_${this.hashString(normalizedKey)}`;
      this.setCache(cacheKey, { original: trimmed, translated: trimmed, lang: 'en' });
      return { translatedText: trimmed, sourceLang: 'en' };
    }

    // キャッシュ確認（スペース・句読点を省いたキー）
    const cacheKey = `trans_en_${this.hashString(normalizedKey)}`;
    const cached = this.getFromCache(cacheKey);
    if (cached && cached.translated) {
      return { translatedText: cached.translated, sourceLang };
    }

    // 翻訳実行
    const translatedText = await this.translateText(trimmed, 'en', sourceLang);
    // 翻訳結果を先ほどの文章とは別でキャッシュ
    this.setCache(cacheKey, { original: trimmed, translated: translatedText, lang: sourceLang });

    return { translatedText, sourceLang };
  }

  /**
   * 2つのテキスト間の変更率（レーベンシュタイン距離に基づく 0.0 〜 1.0）を計算
   * @param {string} text1 
   * @param {string} text2 
   * @returns {number} 変更率 (0.0 = 完全一致, 1.0 = 100%変更)
   */
  calculateChangeRatio(text1, text2) {
    if (text1 === text2) return 0;
    const len1 = text1.length;
    const len2 = text2.length;
    if (len1 === 0) return 1;
    if (len2 === 0) return 1;

    let prevRow = new Array(len2 + 1);
    let currRow = new Array(len2 + 1);

    for (let j = 0; j <= len2; j++) prevRow[j] = j;

    for (let i = 1; i <= len1; i++) {
      currRow[0] = i;
      const char1 = text1.charAt(i - 1);
      for (let j = 1; j <= len2; j++) {
        const cost = char1 === text2.charAt(j - 1) ? 0 : 1;
        currRow[j] = Math.min(
          currRow[j - 1] + 1,     // 挿入
          prevRow[j] + 1,         // 削除
          prevRow[j - 1] + cost   // 置換
        );
      }
      const temp = prevRow;
      prevRow = currRow;
      currRow = temp;
    }

    const distance = prevRow[len2];
    const maxLen = Math.max(len1, len2);
    return distance / maxLen;
  }

  /**
   * 文字列のハッシュ値を計算
   * @param {string} str 
   * @returns {string}
   */
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return String(Math.abs(hash));
  }

  /**
   * キャッシュキーを生成する
   * @param {Choice[]} choices 
   * @param {string|Record<string, any>} context 
   * @param {boolean} includeReason
   * @returns {string}
   */
  generateCacheKey(choices, context, includeReason) {
    const rawStr = typeof context === "string" ? context : JSON.stringify(context);
    const normalizedContext = this.normalizeTextForCache(rawStr);
    const choicesStr = choices.map(c => `${c.id}:${c.name}:${c.description || ''}`).sort().join("|");
    const combined = `${normalizedContext}@@${choicesStr}@@reason:${includeReason ? 1 : 0}`;
    return `nano_judge_${this.hashString(combined)}`;
  }

  /**
   * キャッシュキーの世代管理インデックスリストを取得
   * @returns {string[]}
   */
  getIndexList() {
    if (typeof window === "undefined") return [];
    try {
      const storage = this.options.cacheStorage === 'local' ? window.localStorage : window.sessionStorage;
      const raw = storage.getItem("nano_judge_index_list");
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  /**
   * キャッシュキーの世代管理インデックスリストを保存
   * @param {string[]} list 
   */
  saveIndexList(list) {
    if (typeof window === "undefined") return;
    try {
      const storage = this.options.cacheStorage === 'local' ? window.localStorage : window.sessionStorage;
      storage.setItem("nano_judge_index_list", JSON.stringify(list));
    } catch (_) {}
  }

  /**
   * キャッシュから判定結果を取得（アクセスされたキーはLRUで最新に昇格）
   * @param {string} key 
   * @returns {any|null}
   */
  getFromCache(key) {
    if (!this.options.enableCache) return null;

    let result = null;

    if (this.memoryCache.has(key)) {
      result = this.memoryCache.get(key);
    } else if (typeof window !== "undefined") {
      try {
        const storage = this.options.cacheStorage === 'local' ? window.localStorage : window.sessionStorage;
        const stored = storage.getItem(key);
        if (stored) {
          result = JSON.parse(stored);
          this.memoryCache.set(key, result);
        }
      } catch (_) {}
    }

    if (result) {
      // LRU更新: アクセスされたキーを最新（末尾）へ移動
      if (typeof window !== "undefined") {
        try {
          let indexList = this.getIndexList();
          indexList = indexList.filter(k => k !== key);
          indexList.push(key);
          this.saveIndexList(indexList);
        } catch (_) {}
      }
      return { ...result, fromCache: true };
    }

    return null;
  }

  /**
   * 前方一致するキャッシュと、キャッシュの文字列-5文字減らした文章の間に入力された文章がある場合、
   * そのキャッシュを類推利用する（元のキャッシュ文章が10文字を超える場合のみ）。
   * @param {Choice[]} choices 
   * @param {string|Record<string, any>} context 
   * @param {boolean} includeReason 
   * @returns {JudgementResult|null}
   */
  findPrefixMatchCache(choices, context, includeReason) {
    if (!this.options.enableCache) return null;
    const rawContext = typeof context === "string" ? context : JSON.stringify(context);
    const currentContext = this.normalizeTextForCache(rawContext);
    const targetChoicesKey = choices.map(c => `${c.id}:${c.name}:${c.description || ''}`).sort().join("|");

    // 保存されている世代インデックス（最新順）
    const indexList = this.getIndexList();
    if (!indexList || indexList.length === 0) return null;

    // 最新のキャッシュから順に走査（末尾から逆順）
    for (let i = indexList.length - 1; i >= 0; i--) {
      const key = indexList[i];
      if (!key.startsWith("nano_judge_")) continue;

      let cached = null;
      if (this.memoryCache.has(key)) {
        cached = this.memoryCache.get(key);
      } else if (typeof window !== "undefined") {
        try {
          const storage = this.options.cacheStorage === 'local' ? window.localStorage : window.sessionStorage;
          const stored = storage.getItem(key);
          if (stored) {
            cached = JSON.parse(stored);
            this.memoryCache.set(key, cached);
          }
        } catch (_) {}
      }

      if (!cached || !cached.context) continue;

      // 選択肢の一致確認
      if (cached.choicesKey && cached.choicesKey !== targetChoicesKey) continue;

      const cachedContext = this.normalizeTextForCache(cached.context);
      const cachedLen = cachedContext.length;
      const inputLen = currentContext.length;

      // 条件: 元の文章が10文字を超えた場合のみこの判定を動かす
      if (cachedLen <= 10) continue;

      // 前方一致判定:
      // キャッシュ文字列と (キャッシュ文字列 - 5文字) の間に入力文章がある場合
      // 例: cachedLen - 5 <= inputLen <= cachedLen かつ cachedContext が currentContext で始まる
      const isShortenedMatch = (inputLen >= cachedLen - 5 && inputLen <= cachedLen && cachedContext.startsWith(currentContext));

      // または、入力文章がキャッシュの末尾に1〜5文字追記された場合
      const isExtendedMatch = (inputLen >= cachedLen && inputLen <= cachedLen + 5 && currentContext.startsWith(cachedContext));

      if (isShortenedMatch || isExtendedMatch) {
        // LRUインデックスを最新（末尾）へ更新
        if (typeof window !== "undefined") {
          try {
            let updatedList = this.getIndexList().filter(k => k !== key);
            updatedList.push(key);
            this.saveIndexList(updatedList);
          } catch (_) {}
        }

        return {
          ...cached,
          fromCache: true,
          inferredFromCache: true,
        };
      }
    }

    return null;
  }

  /**
   * 判定結果をキャッシュに保存（最大1000世代を超えた場合は古いものから自動削除）
   * @param {string} key 
   * @param {any} result 
   */
  setCache(key, result) {
    if (!this.options.enableCache) return;

    this.memoryCache.set(key, result);

    if (typeof window !== "undefined") {
      try {
        const storage = this.options.cacheStorage === 'local' ? window.localStorage : window.sessionStorage;

        // 世代インデックスの更新（既存キーは除外して末尾に追加）
        let indexList = this.getIndexList();
        indexList = indexList.filter(k => k !== key);
        indexList.push(key);

        // 指定世代数（デフォルト1000世代）を超過した古いキャッシュを自動削除
        const maxGen = this.options.maxCacheGenerations || 1000;
        while (indexList.length > maxGen) {
          const oldestKey = indexList.shift();
          storage.removeItem(oldestKey);
          this.memoryCache.delete(oldestKey);
        }

        storage.setItem(key, JSON.stringify(result));
        this.saveIndexList(indexList);
      } catch (_) {}
    }
  }

  /**
   * 全キャッシュおよび世代インデックスのクリア
   */
  clearCache() {
    this.memoryCache.clear();
    if (typeof window !== "undefined") {
      try {
        const storage = this.options.cacheStorage === 'local' ? window.localStorage : window.sessionStorage;
        const keysToRemove = [];
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i);
          if (k && (k.startsWith("nano_judge_") || k.startsWith("trans_en_"))) {
            keysToRemove.push(k);
          }
        }
        keysToRemove.forEach(k => storage.removeItem(k));
        storage.removeItem("nano_judge_index_list");
      } catch (_) {}
    }
  }

  /**
   * セッションの初期化
   */
  async initSession() {
    if (this.session) return this.session;

    const languageModel = this.getLanguageModelAPI();
    if (!languageModel) {
      throw new Error("Chrome Prompt API がサポートされていない環境です。");
    }

    const defaultSystemPrompt = 
      "You are a fast, logical decision analyst. Given a context and candidate choices, output strict JSON with probabilities.";

    const sessionOptions = {
      systemPrompt: this.options.systemPrompt || defaultSystemPrompt,
      temperature: this.options.temperature,
      topK: this.options.topK,
    };

    this.session = await languageModel.create(sessionOptions);
    return this.session;
  }

  /**
   * 判定用プロンプトを構築する
   * @param {Choice[]} choices 
   * @param {string|Record<string, any>} context 
   * @param {boolean} includeReason
   * @returns {string}
   */
  buildPrompt(choices, context, includeReason = false) {
    const formattedChoices = choices.map((c) => {
      let desc = c.name;
      if (c.description) desc += ` - ${c.description}`;
      if (c.metadata) desc += ` (${JSON.stringify(c.metadata)})`;
      return `[${c.id}] ${desc}`;
    }).join("\n");

    const exampleRankings = choices.map(c => 
      includeReason 
        ? `    { "id": "${c.id}", "confidence": 0.33, "reason": "<brief explanation>" }`
        : `    { "id": "${c.id}", "confidence": 0.33 }`
    ).join(",\n");

    if (!includeReason) {
      return `
[Context]
${contextStr}

[Choices]
${formattedChoices}

[Task]
Evaluate ALL choices against context. You MUST include ALL ${choices.length} choices in the rankings array (confidence summing to 1.0).
Use strict JSON syntax with commas (never use semicolons).
Output pure JSON only without markdown formatting:
{
  "topChoiceId": "<id>",
  "rankings": [
${exampleRankings}
  ]
}`.trim();
    }

    return `
[Context]
${contextStr}

[Choices]
${formattedChoices}

[Task]
Evaluate ALL choices against context. You MUST include ALL ${choices.length} choices in the rankings array with confidence scores and brief English reasons.
Use strict JSON syntax with commas (never use semicolons).
Output pure JSON only without markdown formatting:
{
  "topChoiceId": "<id>",
  "summaryReason": "<short en reason>",
  "rankings": [
${exampleRankings}
  ]
}`.trim();
  }

  /**
   * レスポンス文字列からJSONを安全にパースする
   * （モデルの軽微な文法崩れやカンマ代わりのセミコロンを自動修復）
   * @param {string} rawText 
   */
  parseJSONResponse(rawText) {
    let clean = rawText.trim();
    if (clean.startsWith("```")) {
      clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    }

    // 1. 標準パース
    try {
      return JSON.parse(clean);
    } catch (_) {}

    // 2. { ... } 部分の抽出パース
    const firstBrace = clean.indexOf("{");
    const lastBrace = clean.lastIndexOf("}");
    let candidate = (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace)
      ? clean.substring(firstBrace, lastBrace + 1)
      : clean;

    try {
      return JSON.parse(candidate);
    } catch (_) {}

    // 3. LLM出力の文法自動修復（コメント除去、区切りセミコロンのカンマ置換、末尾カンマ・セミコロン除去）
    try {
      let sanitized = candidate
        .replace(/\/\/[^\n]*/g, "")
        .replace(/;\s*(?=["{\[\n\r])/g, ",")
        .replace(/;\s*$/gm, ",")
        .replace(/[,;]\s*([\]}])/g, "$1")
        .replace(/,+/g, ",");
      return JSON.parse(sanitized);
    } catch (_) {}

    // 4. 正規表現による堅牢なフォールバック抽出
    try {
      const topChoiceMatch = clean.match(/"topChoiceId"\s*:\s*"([^"]+)"/);
      const summaryReasonMatch = clean.match(/"summaryReason"\s*:\s*"([^"]+)"/);
      const rankings = [];
      const itemRegex = /{\s*"id"\s*:\s*"([^"]+)"\s*,\s*"confidence"\s*:\s*([0-9.]+)(?:\s*,\s*"reason"\s*:\s*"([^"]*)")?\s*}/g;
      let match;
      while ((match = itemRegex.exec(clean)) !== null) {
        const item = {
          id: match[1],
          confidence: parseFloat(match[2]),
        };
        if (match[3] !== undefined) {
          item.reason = match[3];
        }
        rankings.push(item);
      }

      if (rankings.length > 0) {
        return {
          topChoiceId: topChoiceMatch ? topChoiceMatch[1] : rankings[0].id,
          summaryReason: summaryReasonMatch ? summaryReasonMatch[1] : undefined,
          rankings,
        };
      }
    } catch (_) {}

    throw new Error(`Prompt APIの応答をJSONとして解析できませんでした。\n生の出力: ${rawText}`);
  }

  /**
   * <select> 要素の <option> 群から選択肢配列 (Choice[]) を自動抽出する
   * @param {HTMLSelectElement|string} selectOrSelector 
   * @returns {Choice[]}
   */
  extractChoicesFromSelect(selectOrSelector) {
    if (typeof document === 'undefined') return [];
    const selectEl = typeof selectOrSelector === 'string' 
      ? document.querySelector(selectOrSelector) 
      : selectOrSelector;

    if (!selectEl || typeof selectEl.querySelectorAll !== 'function') return [];
    const options = Array.from(selectEl.querySelectorAll('option'));
    return options
      // プレースホルダー用（disabled かつ value が空）を除外
      .filter(opt => !(opt.disabled && !opt.value.trim()))
      .map((opt, idx) => {
        const id = opt.value !== undefined && opt.value !== null && opt.value !== '' ? opt.value : String(idx + 1);
        const name = opt.textContent.trim() || id;
        const description = opt.getAttribute('data-description') || opt.getAttribute('title') || '';
        return { id, name, description };
      })
      .filter(c => c.name !== '');
  }

  /**
   * 選択肢の判定を実行する。
   * @param {Choice[]|HTMLSelectElement|string} choices - 判定対象の選択肢リスト（配列、または select 要素/セレクタ）
   * @param {string|Record<string, any>} context - 状況、条件、質問などの文脈データ
   * @param {Object} [options]
   * @param {boolean} [options.includeReason] - 理由を出力するか
   * @param {string} [options.targetLang] - 理由の翻訳先言語
   * @param {boolean} [options.useCache=true] - キャッシュを利用するか
   * @param {AbortSignal} [options.signal] - キャンセル用シグナル
   * @returns {Promise<JudgementResult>}
   */
  async judge(choices, context, options = {}) {
    // choices が <select> 要素またはセレクタ文字列の場合、自動抽出
    if (typeof choices === 'string' && (choices.startsWith('#') || choices.startsWith('.')) && typeof document !== 'undefined') {
      const el = document.querySelector(choices);
      if (el && el.tagName?.toLowerCase() === 'select') {
        choices = this.extractChoicesFromSelect(el);
      }
    } else if (choices && typeof choices.querySelectorAll === 'function' && choices.tagName?.toLowerCase() === 'select') {
      choices = this.extractChoicesFromSelect(choices);
    }

    if (!choices || choices.length === 0) {
      throw new Error("判定対象の選択肢が空です。");
    }

    if (options.signal && options.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const includeReason = options.includeReason !== undefined ? options.includeReason : this.options.includeReason;
    const useCache = options.useCache !== undefined ? options.useCache : this.options.enableCache;
    const cacheKey = this.generateCacheKey(choices, context, includeReason);

    // キャッシュチェック
    if (useCache) {
      // 1. 完全一致キャッシュ
      const cached = this.getFromCache(cacheKey);
      if (cached) {
        return cached;
      }

      // 2. 前方一致類推キャッシュ（元の文章が10文字超え、かつ5文字以内の揺らぎ）
      const inferred = this.findPrefixMatchCache(choices, context, includeReason);
      if (inferred) {
        return inferred;
      }
    }

    const session = await this.initSession();
    const promptText = this.buildPrompt(choices, context, includeReason);

    if (options.signal && options.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // Prompt API 呼び出し（中断・失敗時はセッションを破棄してリセット）
    let rawResponse;
    try {
      rawResponse = await session.prompt(promptText);
    } catch (err) {
      this.destroy();
      throw err;
    }

    if (options.signal && options.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const parsed = this.parseJSONResponse(rawResponse);
    const choiceMap = new Map(choices.map(c => [c.id, c]));
    const topChoice = choiceMap.get(parsed.topChoiceId) || choices[0];

    // 全選択肢が確実に含まれるように補完（モデルが1件しか返さなかった場合でも全件表示）
    const rawRankings = Array.isArray(parsed.rankings) ? [...parsed.rankings] : [];
    const returnedIds = new Set(rawRankings.map(r => r.id));
    for (const c of choices) {
      if (!returnedIds.has(c.id)) {
        rawRankings.push({ id: c.id, confidence: 0 });
      }
    }

    const targetLang = options.targetLang || (await this.detectLanguage(typeof context === "string" ? context : JSON.stringify(context)));

    let summaryReason = undefined;
    if (includeReason && parsed.summaryReason) {
      summaryReason = await this.translateText(parsed.summaryReason, targetLang);
    }

    const rankings = await Promise.all(rawRankings.map(async (r) => {
      const original = choiceMap.get(r.id);
      let reason = undefined;

      if (includeReason && r.reason) {
        reason = await this.translateText(r.reason, targetLang);
      }

      return {
        id: r.id,
        name: original ? original.name : r.id,
        confidence: typeof r.confidence === "number" ? r.confidence : 0,
        ...(includeReason && reason ? { reason } : {}),
      };
    }));

    rankings.sort((a, b) => b.confidence - a.confidence);

    const contextStr = typeof context === "string" ? context.trim() : JSON.stringify(context);
    const normalizedContext = this.normalizeTextForCache(contextStr);
    const choicesKey = choices.map(c => `${c.id}:${c.name}:${c.description || ''}`).sort().join("|");

    const result = {
      context: normalizedContext,
      rawContext: contextStr,
      choicesKey,
      topChoice,
      rankings,
      ...(includeReason && summaryReason ? { summaryReason } : {}),
      rawResponse,
      fromCache: false,
    };

    if (useCache) {
      this.setCache(cacheKey, result);
    }

    return result;
  }

  /**
   * 入力枠の変更監視と、2秒ルール＆25%変更チェックに基づくバックグラウンド判定制御を初期化
   * @param {HTMLElement} element - 監視対象の入力枠
   * @param {Choice[]|(() => Choice[])} [choices] - 選択肢（または選択肢を動的に返す関数）
   * @param {Object} [options]
   * @param {HTMLSelectElement} [options.selectElement] - 連動する selectbox 要素
   * @param {string} [options.selectSelector] - 連動する selectbox セレクタ
   */
  attachLiveJudgement(element, choices, options = {}) {
    let sessionState = this.elementSessions.get(element);
    if (!sessionState) {
      sessionState = {
        initialText: '',
        initialEnText: '',
        latestText: '',
        startTime: 0,
        isJudging: false,
        abortController: null,
        twoSecondTimer: null,
      };
      this.elementSessions.set(element, sessionState);
    }

    // 連動する selectbox 要素を取得
    const selectSelector = element.getAttribute('data-judge-select') || options.selectSelector;
    let selectEl = options.selectElement || null;
    if (!selectEl && selectSelector && typeof document !== 'undefined') {
      selectEl = document.querySelector(selectSelector);
    }

    // choices が指定されていない場合、selectEl から自動抽出
    if (!choices && selectEl) {
      choices = () => this.extractChoicesFromSelect(selectEl);
    }

    // 判定を実行・管理する内部ヘルパー
    const runJudgement = async (textToJudge, enText) => {
      // 世代IDをインクリメント（最新の実行のみを画面に反映させるため）
      sessionState.currentGeneration = (sessionState.currentGeneration || 0) + 1;
      const myGeneration = sessionState.currentGeneration;

      // 既存判定があれば中断し、Chromeセッションを解放
      if (sessionState.abortController) {
        sessionState.abortController.abort();
        sessionState.abortController = null;
      }
      this.destroy();

      const controller = new AbortController();
      sessionState.abortController = controller;
      sessionState.initialText = textToJudge;
      sessionState.initialEnText = enText;
      sessionState.latestText = textToJudge;
      sessionState.startTime = Date.now();
      sessionState.isJudging = true;

      element.setAttribute('data-judge-status', 'judging');

      // ターゲット要素に「再判定中...」のスピナーを表示
      const targetSelector = element.getAttribute('data-judge-target');
      if (targetSelector) {
        const targetEl = document.querySelector(targetSelector);
        if (targetEl) {
          targetEl.innerHTML = `
            <div style="font-size:0.85rem; color:#38bdf8; display:flex; align-items:center; gap:0.5rem; padding:0.8rem; background:rgba(56,189,248,0.06); border-radius:8px; border:1px solid rgba(56,189,248,0.2);">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="animation: nano-spin 1s linear infinite;">
                <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-opacity="0.25"></circle>
                <path d="M12 2a10 10 0 0 1 10 10"></path>
              </svg>
              <style>@keyframes nano-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }</style>
              <span>Gemini Nano が再判定中...</span>
            </div>
          `;
        }
      }

      // 判定開始から2秒経過した瞬間のチェックタイマー
      if (sessionState.twoSecondTimer) clearTimeout(sessionState.twoSecondTimer);
      sessionState.twoSecondTimer = setTimeout(async () => {
        if (!sessionState.isJudging || myGeneration !== sessionState.currentGeneration) return;
        // 2秒間の間にテキストが変更されていた場合
        if (sessionState.latestText !== sessionState.initialText) {
          const ratio = this.calculateChangeRatio(sessionState.initialText, sessionState.latestText);
          if (ratio >= 0.25) {
            console.log(`[nano-judgement] 2秒経過時テキスト25%以上変化検知 (${Math.round(ratio * 100)}%): 判定を中断して再判定を開始`);
            controller.abort();
            this.destroy();
            const { translatedText } = await this.translateAndCacheEnglish(sessionState.latestText);
            runJudgement(sessionState.latestText, translatedText);
          }
        }
      }, 2000);

      try {
        const reasonAttr = element.getAttribute('data-judge-reason');
        const includeReason = reasonAttr === 'true' ? true : (reasonAttr === 'false' ? false : this.options.includeReason);
        const targetLang = element.getAttribute('data-judge-lang') || undefined;

        // 選択肢の最新状態を取得
        const currentChoices = typeof choices === 'function' ? choices() : choices;
        if (!currentChoices || currentChoices.length === 0) {
          console.warn('[nano-judgement] 判定対象の選択肢が空のためスキップしました。');
          sessionState.isJudging = false;
          element.setAttribute('data-judge-status', 'idle');
          return;
        }

        // 英語翻訳済みテキストを使って判定
        const result = await this.judge(currentChoices, enText, {
          includeReason,
          targetLang,
          signal: controller.signal,
        });

        // 古い世代の判定結果であれば反映を破棄
        if (myGeneration !== sessionState.currentGeneration) {
          console.log(`[nano-judgement] 古い判定結果を破棄 (Gen: ${myGeneration} !== Current: ${sessionState.currentGeneration})`);
          return;
        }

        sessionState.isJudging = false;
        element.setAttribute('data-judge-status', 'completed');
        if (result.fromCache) {
          element.setAttribute('data-judge-cached', 'true');
        }

        // 連動する selectbox があれば自動で該当選択肢を選択
        const autoSelectAttr = element.getAttribute('data-judge-auto-select');
        const shouldAutoSelect = autoSelectAttr !== null ? autoSelectAttr !== 'false' : (selectEl !== null);

        if (selectEl && shouldAutoSelect && result.topChoice) {
          if (selectEl.value !== result.topChoice.id) {
            selectEl.value = result.topChoice.id;
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }

        if (targetSelector) {
          const targetEl = document.querySelector(targetSelector);
          if (targetEl) {
            this.renderResultToElement(targetEl, result);
          }
        }

        element.dispatchEvent(new CustomEvent('nano-judgement-complete', {
          detail: { result, element, choices: currentChoices, fromCache: result.fromCache, selectElement: selectEl },
          bubbles: true,
        }));
      } catch (err) {
        if (err.name === 'AbortError') {
          console.log('[nano-judgement] 判定が中断されました（テキスト変更による再判定）');
        } else {
          if (myGeneration === sessionState.currentGeneration) {
            sessionState.isJudging = false;
            element.setAttribute('data-judge-status', 'error');
            console.error('[nano-judgement] 判定エラー:', err);
          }
        }
      }
    };

    // 入力イベントハンドラ
    const handleInput = async () => {
      const currentText = ('value' in element ? element.value : element.textContent || '').trim();

      // 5文字未満の場合はスキップ
      if (currentText.length < 5) {
        return;
      }

      const now = Date.now();

      // ケース1: まだ判定が動いていない場合
      if (!sessionState.isJudging) {
        // Language Detector と Translator API を使って英語に翻訳＆キャッシュ
        const { translatedText } = await this.translateAndCacheEnglish(currentText);
        // 裏で事前の判定を開始
        runJudgement(currentText, translatedText);
        return;
      }

      // ケース2: 判定が進行中の場合
      const elapsed = now - sessionState.startTime;

      if (elapsed <= 2000) {
        // 【2秒以内の場合】
        // 再度英語に翻訳して、先ほどの文章とは別でキャッシュする
        sessionState.latestText = currentText;
        await this.translateAndCacheEnglish(currentText);
      } else {
        // 【判定開始から2秒を超える場合】
        sessionState.latestText = currentText;
        // 英語に翻訳＆キャッシュ
        const { translatedText } = await this.translateAndCacheEnglish(currentText);

        // 最初に保存されている文章と変更された文章のテキストの25%が変わっているかチェック
        const ratio = this.calculateChangeRatio(sessionState.initialText, currentText);

        if (ratio >= 0.25) {
          // 25%が変わっている場合は、進んでいる判定を止めて再度選択肢の判定を行う
          console.log(`[nano-judgement] 2秒後テキスト25%以上変化検知 (${Math.round(ratio * 100)}%): 判定を停止して再実行`);
          if (sessionState.abortController) {
            sessionState.abortController.abort();
          }
          runJudgement(currentText, translatedText);
        } else {
          console.log(`[nano-judgement] テキスト変化率 ${Math.round(ratio * 100)}% (25%未満): 進行中の判定を維持`);
        }
      }
    };

    element.removeEventListener('input', element._nanoJudgeInputHandler);
    element._nanoJudgeInputHandler = handleInput;
    element.addEventListener('input', handleInput);

    // すでに初期テキストが5文字以上ある場合は初回トリガー
    const initialVal = ('value' in element ? element.value : element.textContent || '').trim();
    if (initialVal.length >= 5) {
      handleInput();
    }
  }

  /**
   * ページ内の特定の属性（data-nano-judgement）を持つ全入力枠をスキャンし、
   * リスナーの登録および即時判定を開始する。
   * @param {Object} [scanOptions]
   */
  async scanAndJudge(scanOptions = {}) {
    if (typeof document === "undefined") return [];

    const selector = scanOptions.selector || '[data-nano-judgement]';
    const elements = Array.from(document.querySelectorAll(selector));

    if (elements.length === 0) {
      return [];
    }

    const results = [];

    for (const el of elements) {
      let elementChoices = null;
      let selectElement = null;

      // 1. data-judge-select 属性のチェック（selectbox との連携）
      const selectAttr = el.getAttribute('data-judge-select');
      if (selectAttr) {
        selectElement = document.querySelector(selectAttr);
        if (selectElement && selectElement.tagName?.toLowerCase() === 'select') {
          elementChoices = () => this.extractChoicesFromSelect(selectElement);
        }
      }

      // 2. data-judge-choices 属性のチェック（JSON または要素セレクタ）
      if (!elementChoices) {
        const choicesAttr = el.getAttribute('data-judge-choices');
        if (choicesAttr) {
          try {
            if (choicesAttr.startsWith('[') || choicesAttr.startsWith('{')) {
              elementChoices = JSON.parse(choicesAttr);
            } else {
              const choiceSource = document.querySelector(choicesAttr);
              if (choiceSource) {
                if (choiceSource.tagName?.toLowerCase() === 'select') {
                  selectElement = choiceSource;
                  elementChoices = () => this.extractChoicesFromSelect(choiceSource);
                } else {
                  elementChoices = JSON.parse(choiceSource.textContent || '[]');
                }
              }
            }
          } catch (e) {
            console.error(`選択肢JSONのパースに失敗しました (要素:`, el, e);
          }
        }
      }

      const choicesToUse = elementChoices || scanOptions.defaultChoices || this.options.defaultChoices;

      if (!choicesToUse && !selectElement) {
        continue;
      }

      // リアルタイム入力監視・事前判定・2秒/25%ルール制御を取り付ける
      this.attachLiveJudgement(el, choicesToUse, { ...scanOptions, selectElement });
      results.push({ element: el, choices: choicesToUse, selectElement });
    }

    return results;
  }

  /**
   * 指定した要素に判定結果のHTMLを描画するヘルパー
   * @param {HTMLElement} container 
   * @param {JudgementResult} result 
   */
  renderResultToElement(container, result) {
    let cachedBadge = '<span class="badge" style="font-size:0.75rem; background:rgba(56,189,248,0.2); color:#38bdf8; padding:0.2rem 0.5rem; border-radius:4px;">新規判定</span>';
    if (result.fromCache) {
      if (result.inferredFromCache) {
        cachedBadge = '<span class="badge" style="font-size:0.75rem; background:rgba(192,132,252,0.2); color:#c084fc; padding:0.2rem 0.5rem; border-radius:4px;">⚡ 前方一致類推キャッシュ</span>';
      } else {
        cachedBadge = '<span class="badge badge-ok" style="font-size:0.75rem; background:rgba(74,222,128,0.2); color:#4ade80; padding:0.2rem 0.5rem; border-radius:4px;">⚡ キャッシュから即時復元</span>';
      }
    }

    const rankingsHtml = (result.rankings || []).map(r => {
      const pct = Math.round((r.confidence || 0) * 100);
      const reasonHtml = r.reason 
        ? `<div style="font-size:0.8rem; color:#94a3b8; margin-top:0.2rem;">${r.reason}</div>` 
        : '';

      return `
        <div style="margin-top:0.4rem; padding:0.5rem 0.7rem; background:rgba(0,0,0,0.25); border-radius:6px; border:1px solid rgba(255,255,255,0.05);">
          <div style="display:flex; justify-content:space-between; font-weight:600; font-size:0.9rem;">
            <span>[${r.id}] ${r.name}</span>
            <span style="color:#38bdf8;">${pct}% (${r.confidence})</span>
          </div>
          <div style="height:6px; background:rgba(255,255,255,0.1); border-radius:3px; margin:0.3rem 0; overflow:hidden;">
            <div style="height:100%; width:${pct}%; background:linear-gradient(90deg, #38bdf8, #c084fc); border-radius:3px;"></div>
          </div>
          ${reasonHtml}
        </div>
      `;
    }).join('');

    const summaryHtml = result.summaryReason 
      ? `<div style="font-size:0.88rem; color:#cbd5e1; margin-bottom:0.8rem; line-height:1.5;">${result.summaryReason}</div>` 
      : '';

    container.innerHTML = `
      <div style="border:1px solid rgba(56,189,248,0.3); background:rgba(56,189,248,0.06); border-radius:10px; padding:1.2rem; margin-top:0.6rem;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
          <div style="font-size:0.75rem; color:#38bdf8; font-weight:700; text-transform:uppercase;">最有力候補</div>
          ${cachedBadge}
        </div>
        <div style="font-size:1.3rem; font-weight:700; margin-bottom:0.4rem; color:#f0f6fc;">${result.topChoice.name}</div>
        ${summaryHtml}
        <div style="font-weight:600; font-size:0.85rem; margin-top:0.6rem; color:#94a3b8;">全候補の確率 (確信度):</div>
        ${rankingsHtml}
      </div>
    `;
  }

  /**
   * セッションの破棄
   */
  destroy() {
    if (this.session && typeof this.session.destroy === "function") {
      this.session.destroy();
      this.session = null;
    }
  }
}

if (typeof window !== "undefined") {
  window.NanoJudgement = NanoJudgement;
}
