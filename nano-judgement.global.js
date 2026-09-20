/**
 * nano-judgement.global.js
 * 
 * 通常の <script src="nano-judgement.global.js"></script> タグで読み込んで
 * 即座に window.NanoJudgement を利用できるようにしたスタンドアロン版です。
 * 
 * - 出力速度を最速にするため、デフォルトでは選択肢の確率（確信度）のみを出力します。
 * - 理由が必要な場合（includeReason: true / data-judge-reason="true"）のみ理由を生成し、
 *   Chrome の Translator API (window.translation / ai.translator) で入力言語に翻訳して出力します。
 * - 5文字以上のテキスト入力時、Language Detector API と Translator API を使って英語に事前翻訳・キャッシュ。
 * - バックグラウンド事前判定を開始し、2秒以内の再更新キャッシュ分離、および2秒経過後/経過時における25%以上のテキスト変更時の判定中断＆再判定に対応。
 */
(function (global) {
  'use strict';

  class NanoJudgement {
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
      this.choicesPairCache = new Map();
      this.inflightJudgements = new Map();
      this.elementSessions = new WeakMap();

      if (this.options.autoScan && typeof document !== "undefined") {
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", () => this.scanAndJudge());
        } else {
          setTimeout(() => this.scanAndJudge(), 0);
        }
      }
    }

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

      if (/[ぁ-んァ-ヶ一-龠々]/.test(text)) {
        return 'ja';
      }
      return 'en';
    }

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

    normalizeTextForCache(text) {
      if (typeof text !== "string") return "";
      return text.replace(/[\s\u3000\u3001\u3002\uFF0C\uFF0E\uFF01\uFF1F\u30FB\u2026,;.!?！？・…]+/g, "");
    }

    async translateAndCacheEnglish(text) {
      const trimmed = text.trim();
      const normalizedKey = this.normalizeTextForCache(trimmed);
      const sourceLang = await this.detectLanguage(trimmed);

      if (sourceLang === 'en') {
        const cacheKey = `trans_en_${this.hashString(normalizedKey)}`;
        this.setCache(cacheKey, { original: trimmed, translated: trimmed, lang: 'en' });
        return { translatedText: trimmed, sourceLang: 'en' };
      }

      const cacheKey = `trans_en_${this.hashString(normalizedKey)}`;
      const cached = this.getFromCache(cacheKey);
      if (cached && cached.translated) {
        return { translatedText: cached.translated, sourceLang };
      }

      const translatedText = await this.translateText(trimmed, 'en', sourceLang);
      this.setCache(cacheKey, { original: trimmed, translated: translatedText, lang: sourceLang });

      return { translatedText, sourceLang };
    }

    async translateAndPairChoices(choices) {
      if (!choices || choices.length === 0) {
        return { originalChoices: [], translatedChoices: [], pairMap: new Map() };
      }

      const choicesKey = choices.map(c => `${c.id}:${c.name}:${c.description || ''}`).sort().join("|");
      if (this.choicesPairCache && this.choicesPairCache.has(choicesKey)) {
        return this.choicesPairCache.get(choicesKey);
      }

      const pairMap = new Map();
      const translatedChoices = await Promise.all(choices.map(async (c) => {
        const textToDetect = `${c.name} ${c.description || ''}`.trim();
        const lang = await this.detectLanguage(textToDetect);

        let nameEn = c.name;
        let descriptionEn = c.description;

        if (lang !== 'en') {
          nameEn = await this.translateText(c.name, 'en', lang);
          if (c.description) {
            descriptionEn = await this.translateText(c.description, 'en', lang);
          }
        }

        const translatedChoice = {
          ...c,
          name: nameEn,
          description: descriptionEn,
        };

        pairMap.set(c.id, {
          original: c,
          translated: translatedChoice,
        });

        return translatedChoice;
      }));

      const result = {
        originalChoices: choices,
        translatedChoices,
        pairMap,
      };

      if (!this.choicesPairCache) {
        this.choicesPairCache = new Map();
      }
      this.choicesPairCache.set(choicesKey, result);

      return result;
    }

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
            currRow[j - 1] + 1,
            prevRow[j] + 1,
            prevRow[j - 1] + cost
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

    hashString(str) {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
      }
      return String(Math.abs(hash));
    }

    generateCacheKey(choices, context, includeReason) {
      const rawStr = typeof context === "string" ? context : JSON.stringify(context);
      const normalizedContext = this.normalizeTextForCache(rawStr);
      const choicesStr = choices.map(c => `${c.id}:${c.name}:${c.description || ''}`).sort().join("|");
      const combined = `${normalizedContext}@@${choicesStr}@@reason:${includeReason ? 1 : 0}`;
      return `nano_judge_${this.hashString(combined)}`;
    }

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

    saveIndexList(list) {
      if (typeof window === "undefined") return;
      try {
        const storage = this.options.cacheStorage === 'local' ? window.localStorage : window.sessionStorage;
        storage.setItem("nano_judge_index_list", JSON.stringify(list));
      } catch (_) {}
    }

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

    findPrefixMatchCache(choices, context, includeReason) {
      if (!this.options.enableCache) return null;
      const rawContext = typeof context === "string" ? context : JSON.stringify(context);
      const currentContext = this.normalizeTextForCache(rawContext);
      const targetChoicesKey = choices.map(c => `${c.id}:${c.name}:${c.description || ''}`).sort().join("|");

      const indexList = this.getIndexList();
      if (!indexList || indexList.length === 0) return null;

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

    buildPrompt(choices, context, includeReason = false) {
      const formattedChoices = choices.map((c) => {
        let desc = c.name;
        if (c.description) desc += ` - ${c.description}`;
        if (c.metadata) desc += ` (${JSON.stringify(c.metadata)})`;
        return `[${c.id}] ${desc}`;
      }).join("\n");

      const contextStr = typeof context === "string" ? context : JSON.stringify(context);

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

    extractChoicesFromSelect(selectOrSelector) {
      if (typeof document === 'undefined') return [];
      const selectEl = typeof selectOrSelector === 'string' 
        ? document.querySelector(selectOrSelector) 
        : selectOrSelector;

      if (!selectEl || typeof selectEl.querySelectorAll !== 'function') return [];
      const options = Array.from(selectEl.querySelectorAll('option'));
      return options
        .filter(opt => !(opt.disabled && !opt.value.trim()))
        .map((opt, idx) => {
          const id = opt.value !== undefined && opt.value !== null && opt.value !== '' ? opt.value : String(idx + 1);
          const name = opt.textContent.trim() || id;
          const description = opt.getAttribute('data-description') || opt.getAttribute('title') || '';
          return { id, name, description };
        })
        .filter(c => c.name !== '');
    }

    async judge(choices, context, options = {}) {
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

      if (useCache) {
        const cached = this.getFromCache(cacheKey);
        if (cached) {
          return cached;
        }

        const inferred = this.findPrefixMatchCache(choices, context, includeReason);
        if (inferred) {
          return inferred;
        }
      }

      // 3. 既に同一条件の先行判定が実行中の場合は、二重実行せずその完了を待つ（先行判定との合流）
      if (this.inflightJudgements.has(cacheKey)) {
        return await this.inflightJudgements.get(cacheKey);
      }

      const execute = async () => {
        // 選択肢の言語判定・翻訳を行い、元の選択肢と翻訳された選択肢のペアを保持
        const choicePairs = await this.translateAndPairChoices(choices);

        const session = await this.initSession();
        // Prompt API には翻訳された選択肢（英語）を渡す
        const promptText = this.buildPrompt(choicePairs.translatedChoices, context, includeReason);

        if (options.signal && options.signal.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

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
        // 保持していたペア（組み合わせ）から元の選択肢を復元
        const originalChoiceMap = choicePairs.pairMap;
        const topPair = originalChoiceMap.get(parsed.topChoiceId);
        const topChoice = topPair ? topPair.original : choices[0];

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
          // 翻訳の組み合わせから元の選択肢の名前を復元
          const pair = originalChoiceMap.get(r.id);
          const original = pair ? pair.original : null;
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
      };

      const inflightPromise = execute();
      this.inflightJudgements.set(cacheKey, inflightPromise);
      try {
        return await inflightPromise;
      } finally {
        this.inflightJudgements.delete(cacheKey);
      }
    }

    preJudge(choices, context, options = {}) {
      return this.judge(choices, context, options);
    }

    isJudging(choices, context, includeReason = false) {
      const cacheKey = this.generateCacheKey(choices, context, includeReason);
      return this.inflightJudgements.has(cacheKey);
    }

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
          currentGeneration: 0,
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

      const runJudgement = async (textToJudge, enText) => {
        sessionState.currentGeneration = (sessionState.currentGeneration || 0) + 1;
        const myGeneration = sessionState.currentGeneration;

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

        // 判定開始イベントを発火（画面描画・スピナー表示はHTML側の責務）
        element.dispatchEvent(new CustomEvent('nano-judgement-start', {
          detail: { element, textToJudge, selectElement: selectEl },
          bubbles: true,
        }));

        if (sessionState.twoSecondTimer) clearTimeout(sessionState.twoSecondTimer);
        sessionState.twoSecondTimer = setTimeout(async () => {
          if (!sessionState.isJudging || myGeneration !== sessionState.currentGeneration) return;
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

          const result = await this.judge(currentChoices, enText, {
            includeReason,
            targetLang,
            signal: controller.signal,
          });

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

      const handleInput = async () => {
        const rawText = ('value' in element ? element.value : element.textContent || '');
        const cleanText = rawText.replace(/[\s\u3000]+/g, '');

        // スペースなどを削除して0文字になったら判定を即時停止＆リセット
        if (cleanText.length === 0) {
          if (sessionState.twoSecondTimer) {
            clearTimeout(sessionState.twoSecondTimer);
            sessionState.twoSecondTimer = null;
          }
          if (sessionState.abortController) {
            sessionState.abortController.abort();
            sessionState.abortController = null;
          }
          this.destroy();

          sessionState.currentGeneration = (sessionState.currentGeneration || 0) + 1;
          sessionState.isJudging = false;
          sessionState.initialText = '';
          sessionState.initialEnText = '';
          sessionState.latestText = '';
          element.setAttribute('data-judge-status', 'idle');
          element.removeAttribute('data-judge-cached');



          element.dispatchEvent(new CustomEvent('nano-judgement-cancelled', {
            detail: { element, reason: 'empty_input' },
            bubbles: true,
          }));

          return;
        }

        const currentText = rawText.trim();

        if (currentText.length < 5) {
          return;
        }

        const now = Date.now();

        if (!sessionState.isJudging) {
          const { translatedText } = await this.translateAndCacheEnglish(currentText);
          runJudgement(currentText, translatedText);
          return;
        }

        const elapsed = now - sessionState.startTime;

        if (elapsed <= 2000) {
          sessionState.latestText = currentText;
          await this.translateAndCacheEnglish(currentText);
        } else {
          sessionState.latestText = currentText;
          const { translatedText } = await this.translateAndCacheEnglish(currentText);

          const ratio = this.calculateChangeRatio(sessionState.initialText, currentText);

          if (ratio >= 0.25) {
            console.log(`[nano-judgement] 2秒後テキスト25%以上変化検知 (${Math.round(ratio * 100)}%): 判定を停止して再実行`);
            if (sessionState.abortController) {
              sessionState.abortController.abort();
              sessionState.abortController = null;
            }
            this.destroy();
            runJudgement(currentText, translatedText);
          } else {
            console.log(`[nano-judgement] テキスト変化率 ${Math.round(ratio * 100)}% (25%未満): 進行中の判定を維持`);
          }
        }
      };

      element.removeEventListener('input', element._nanoJudgeInputHandler);
      element._nanoJudgeInputHandler = handleInput;
      element.addEventListener('input', handleInput);

      const initialVal = ('value' in element ? element.value : element.textContent || '').trim();
      if (initialVal.length >= 5) {
        handleInput();
      }
    }

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

        this.attachLiveJudgement(el, choicesToUse, { ...scanOptions, selectElement });
        results.push({ element: el, choices: choicesToUse, selectElement });
      }

      return results;
    }



    destroy() {
      if (this.session && typeof this.session.destroy === "function") {
        this.session.destroy();
        this.session = null;
      }
    }
  }

  global.NanoJudgement = NanoJudgement;

})(typeof window !== 'undefined' ? window : globalThis);
