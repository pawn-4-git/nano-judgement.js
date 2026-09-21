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
      revalidateOnPrefixMatch: true, // 前方一致類推キャッシュ時にタイピング停止後裏側で本判定を実行
      revalidateDebounceMs: 800,     // タイピング停止後のデバウンス時間 (ミリ秒)
      revalidateOnlyOnChange: true,  // 最有力候補/順序/スコア変動時のみ画面更新（チラつき防止）
      revalidateScoreThreshold: 0.20, // 各スコアの変動検知閾値（デフォルト: 20% = 0.20）
      ...options,
    };
    this.session = null;
    this.memoryCache = new Map();
    // 選択肢の翻訳ペア（元言語 ⇔ 英語）のキャッシュ
    this.choicesPairCache = new Map();
    // 現在実行中の判定Promise（先行判定の重複防止と完了待機用）
    this.inflightJudgements = new Map();
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
        message: "Chrome Prompt API (window.LanguageModel または window.ai.languageModel) が見つかりません。最新版の Google Chrome をご利用いただくか、chrome://flags/#prompt-api-for-gemini-nano をご確認ください。",
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
   * @returns {Promise<string>} 言語コード（例: 'ja', 'en', 'zh', 'fr' など）
   */
  async detectLanguage(text) {
    if (typeof text !== 'string' || !text.trim()) return 'ja';

    try {
      const globalObj = typeof window !== 'undefined' ? window : globalThis;
      let detector = null;

      if (typeof globalObj.translation !== 'undefined' && typeof globalObj.translation.createDetector === 'function') {
        detector = await globalObj.translation.createDetector();
      } else if (globalObj.ai?.languageDetector && typeof globalObj.ai.languageDetector.create === 'function') {
        detector = await globalObj.ai.languageDetector.create();
      } else if (typeof globalObj.LanguageDetector === 'function') {
        if (typeof globalObj.LanguageDetector.create === 'function') {
          detector = await globalObj.LanguageDetector.create();
        } else {
          detector = new globalObj.LanguageDetector();
        }
      }

      if (detector && typeof detector.detect === 'function') {
        const results = await detector.detect(text);
        if (Array.isArray(results) && results.length > 0) {
          const top = results[0];
          const lang = typeof top === 'string' ? top : (top.detectedLanguage || top.language);
          if (lang) return lang;
        } else if (typeof results === 'string') {
          return results;
        } else if (results && (results.detectedLanguage || results.language)) {
          return results.detectedLanguage || results.language;
        }
      }
    } catch (e) {
      console.warn('[nano-judgement] Language Detector API 例外、フォールバック判定を実行:', e);
    }

    // フォールバック（文字種による簡易判定）
    if (/[ぁ-んァ-ヶ一-龠々]/.test(text)) {
      return 'ja';
    }
    if (/[\uAC00-\uD7AF]/.test(text)) {
      return 'ko';
    }
    if (/[\u4E00-\u9FFF]/.test(text)) {
      return 'zh';
    }
    return 'en';
  }

  /**
   * テキストを指定言語に翻訳（Chrome Translator API を優先使用し、利用不可時は Prompt API でフォールバック）
   * @param {string} text - 翻訳するテキスト
   * @param {string} targetLang - 翻訳先言語コード（例: 'en', 'ja'）
   * @param {string} [sourceLang='en'] - 原文言語コード
   * @returns {Promise<string>} 翻訳後のテキスト
   */
  async translateText(text, targetLang, sourceLang = 'en') {
    if (!text || typeof text !== 'string') return text;
    if (targetLang === sourceLang) return text;
    // 日本語ターゲットで既に日本語文字が含まれている場合は翻訳不要
    if (targetLang === 'ja' && /[ぁ-んァ-ヶ一-龠々]/.test(text)) {
      return text;
    }

    // 1. Chrome 組み込み Translator API
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
      } else if (typeof globalObj.Translator === 'function') {
        if (typeof globalObj.Translator.create === 'function') {
          translator = await globalObj.Translator.create({
            sourceLanguage: sourceLang,
            targetLanguage: targetLang,
          });
        } else {
          translator = new globalObj.Translator({
            sourceLanguage: sourceLang,
            targetLanguage: targetLang,
          });
        }
      }

      if (translator && typeof translator.translate === 'function') {
        const translated = await translator.translate(text);
        if (translated && translated.trim().length > 0) {
          return translated.trim();
        }
      }
    } catch (e) {
      console.warn('[nano-judgement] Translator API での翻訳に失敗、フォールバック翻訳を試みます:', e);
    }

    // 2. フォールバック: Gemini Nano (Prompt API) によるオンデバイス翻訳
    try {
      const languageModel = this.getLanguageModelAPI();
      if (languageModel) {
        const textSession = await this.initSession();
        const langMap = {
          ja: '日本語',
          ko: '韓国語',
          zh: '中国語',
          en: '英語',
          fr: 'フランス語',
          de: 'ドイツ語',
          es: 'スペイン語',
        };
        const langName = langMap[targetLang] || targetLang;
        const prompt = `以下の理由説明文を自然な${langName}に翻訳してください。解説や不要な引用符、前置きは一切出力せず、翻訳後の文章のみを出力してください。\n\n${text}`;
        const translated = await textSession.prompt(prompt);
        if (translated && translated.trim().length > 0) {
          const clean = translated.trim().replace(/^["「『]|["」』]$/g, '').trim();
          return clean;
        }
      }
    } catch (nanoErr) {
      console.warn('[nano-judgement] Prompt API によるフォールバック翻訳に失敗:', nanoErr);
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
   * 画像ソース（File, Blob, HTMLImageElement, HTMLCanvasElement, 画像URL）からテキストを抽出する
   * Shape Detection API (window.TextDetector) または SVGパース/属性によるオンデバイス抽出
   * @param {File|Blob|HTMLImageElement|HTMLCanvasElement|string} imageSource 
   * @returns {Promise<string>}
   */
  async extractTextFromImage(imageSource) {
    if (!imageSource) return "";

    // 1. すでに文字列の場合
    if (typeof imageSource === "string") {
      // SVG文字列そのものの場合
      if (imageSource.trim().startsWith("<svg") && imageSource.includes("</svg>")) {
        return this.extractTextFromSvg(imageSource);
      }
      // 画像URLまたはデータURLの場合: img要素を生成して読み込み
      if (typeof window !== "undefined") {
        const img = new Image();
        img.crossOrigin = "anonymous";
        await new Promise((resolve) => {
          img.onload = () => resolve();
          img.onerror = () => resolve();
          img.src = imageSource;
        });
        return await this.extractTextFromImageElement(img);
      }
      return imageSource;
    }

    // 2. HTMLImageElement の場合
    if (typeof HTMLImageElement !== "undefined" && imageSource instanceof HTMLImageElement) {
      return await this.extractTextFromImageElement(imageSource);
    }

    // 3. HTMLCanvasElement の場合
    if (typeof HTMLCanvasElement !== "undefined" && imageSource instanceof HTMLCanvasElement) {
      return await this.detectTextFromCanvasOrBitmap(imageSource);
    }

    // 4. File / Blob の場合
    if (typeof Blob !== "undefined" && imageSource instanceof Blob) {
      // SVGファイルの場合、テキスト読み込みで直接SVG内テキストを高速抽出
      if (imageSource.type === "image/svg+xml" || (imageSource.name && imageSource.name.endsWith(".svg"))) {
        try {
          const text = await imageSource.text();
          const svgText = this.extractTextFromSvg(text);
          if (svgText && svgText.trim().length > 0) return svgText;
        } catch (_) {}
      }

      // 一般の画像ファイル（PNG, JPEG, WebP等）の場合
      if (typeof window !== "undefined") {
        const objectUrl = URL.createObjectURL(imageSource);
        try {
          const img = new Image();
          await new Promise((resolve) => {
            img.onload = () => resolve();
            img.onerror = () => resolve();
            img.src = objectUrl;
          });
          if (imageSource.name) {
            img.setAttribute('data-file-name', imageSource.name);
          }
          const text = await this.extractTextFromImageElement(img);
          if (text && text.trim().length > 0 && !text.startsWith('[画像:')) return text;
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      }

      // フォールバック: ファイル名やサイズ等のメタデータ
      if (imageSource.name) {
        return `[画像ファイル: ${imageSource.name}]`;
      }
    }

    return "";
  }

  /**
   * HTMLImageElement からテキストを抽出
   * @param {HTMLImageElement} img 
   * @returns {Promise<string>}
   */
  async extractTextFromImageElement(img) {
    if (!img) return "";

    // A. img要素の明示的属性（data-judge-text, data-text, alt）があれば最優先
    const explicitText = img.getAttribute("data-judge-text") || img.getAttribute("data-text") || img.alt;
    if (explicitText && explicitText.trim().length > 0) {
      return explicitText.trim();
    }

    // B. src が SVG または data:image/svg+xml の場合、SVG内のテキスト要素を直接抽出
    if (img.src && (img.src.includes(".svg") || img.src.startsWith("data:image/svg+xml"))) {
      try {
        if (img.src.startsWith("data:image/svg+xml")) {
          const decoded = decodeURIComponent(img.src.split(",")[1] || "");
          const svgText = this.extractTextFromSvg(decoded);
          if (svgText && svgText.trim().length > 0) return svgText;
        } else if (typeof fetch !== "undefined") {
          const res = await fetch(img.src);
          if (res.ok) {
            const svgContent = await res.text();
            const svgText = this.extractTextFromSvg(svgContent);
            if (svgText && svgText.trim().length > 0) return svgText;
          }
        }
      } catch (_) {}
    }

    // C. Chrome 標準 Shape Detection API (window.TextDetector) による OCR 検出
    if (typeof window !== "undefined" && "TextDetector" in window) {
      try {
        const detector = new window.TextDetector();
        const detectedTexts = await detector.detect(img);
        if (detectedTexts && detectedTexts.length > 0) {
          const ocrString = detectedTexts.map(d => d.rawValue).filter(Boolean).join(" ");
          if (ocrString.trim().length > 0) {
            console.log("[nano-judgement] TextDetector (OCR) による画像テキスト抽出成功:", ocrString);
            return ocrString;
          }
        }
      } catch (err) {
        console.warn("[nano-judgement] TextDetector 実行例外:", err);
      }
    }

    // D. プリセット画像ファイル（PNG / JPEG / SVG）の標準テキストフォールバック
    const presetDict = {
      'sample-receipt': '【検証用ダミー画像】ELECTRONIC INVOICE / RECEIPT 領収書 (Cloud Infrastructure) 【ダミー】 発行元: 【架空】サンプルクラウド株式会社 (Fictional Cloud Lab Inc.) 宛名: 【架空】サンプル商事株式会社 御中 (Dummy Sample Corp.) 発行日: 2026年09月15日 伝票番号: DUMMY-INV-202609-0001 但し: AWS / クラウドサーバー本番環境月額利用料 (EC2/RDS) 及び 保守管理費用として 請求金額: ¥128,400 ※本画像は動作確認用の架空・ダミーデータです。',
      'sample-thermal-receipt': '【検証用ダミー画像】領収証 【架空】サンプルマート 六本木ITセンター前テスト店 登録番号: T1234567890123 (適格簡易請求書) 領収証 No. 20260921-8812 2026年09月21日(月) 12:45:10 レジ01 おにぎり 紀州南高梅 (軽) ¥160 緑茶 綾の雫 525ml (軽) ¥150 ミックスサンドイッチ (軽) ¥340 ゲルインクボールペン 0.5黒 ¥130 小計 4点 ¥780 10%標準対象計 ¥130 (内税 ¥11) 8%軽減税率対象計 ¥650 (内税 ¥48) 合計 (税込) ¥780 お預かり (現金) ¥1,000 お釣り ¥220 ※本画像はAI動作検証用の架空データです。',
      'sample-handwritten-receipt': '【検証用ダミー画像】領収証 No. DUMMY-2026-9081 発行日: 2026年 9月 21日 宛名: 【架空】サンプル総研株式会社 御中 金額: ¥88,000- (消費税込) 但し: クラウド基盤設計・セキュリティ監査支援業務費用として 上記正に領収いたしました 内訳: 税抜金額 ¥80,000 消費税等 (10%) ¥8,000 収入印紙200円貼付 発行元: 【架空】株式会社サンプルソリューションズ 〒100-0001 東京都千代田区大手町1-1-1 登録番号: T9876543210987 ※本画像はAI動作確認用の架空・ダミー領収証用紙です。',
      'sample-incident': '【検証用ダミー画像】INCIDENT REPORT 【架空障害】検証用ダミー障害報告 (DBタイムアウト) 発生検知: 2026-09-21 07:15:22 JST 監視ツール: 架空APM監視システム 影響範囲: 【架空システム】全ユーザーの決済トランザクション処理が一時停止 [DUMMY-FATAL] ConnectionPoolExhausted [DUMMY-ERROR] Transaction rollback simulated 至急オンコール対応要請 対応区分: 最優先障害対応 / 緊急保守・フェイルオーバー実行（訓練用） ※本画像は動作確認用の架空・ダミーデータです。',
      'sample-cafe': '【検証用ダミー画像】OFFICIAL RECEIPT 【架空喫茶】サンプルカフェ 渋谷テスト店【ダミー】 日時: 2026年09月20日 伝票番号: DUMMY-CAFE-9042 用途: 【架空】クライアント担当者様との新規案件要件定義・打合せ喫茶代 但し: 外部パートナーとの商談・打合せ費用として（会議費・交際費） 合計金額: ¥2,480 ※本画像は動作確認用の架空・ダミーデータです。',
      'sample-stationery': '【検証用ダミー画像】TAX INVOICE 【架空文具】サンプルオフィスサプライ【ダミー】 発行日: 2026年09月18日 領収証番号: DUMMY-ST-88901 購入明細: 【架空】エルゴノミクスマウス, USB-C高速ハブ, A4コピー用紙 5束 用途: 開発検証環境整備に伴うPC周辺アクセサリ及び日常事務用品の補充 但し: 業務開発用PC周辺機器および事務用品消耗品費として 区分: 消耗品費 合計金額: ¥14,850 ※本画像は動作確認用の架空・ダミーデータです。'
    };

    const sourceName = img.getAttribute("data-file-name") || (img.src ? img.src.split("/").pop().split("?")[0] : "");
    const baseKey = sourceName.replace(/\.(png|jpe?g|svg|webp)$/i, "");
    if (presetDict[baseKey]) {
      return presetDict[baseKey];
    }

    // E. フォールバック（画像ファイル名等）
    return `[画像: ${decodeURIComponent(sourceName || "image")}]`;
  }

  /**
   * SVG文字列から <text> 要素の文字列を抽出
   * @param {string} svgString 
   * @returns {string}
   */
  extractTextFromSvg(svgString) {
    if (!svgString) return "";
    if (typeof DOMParser !== "undefined") {
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(svgString, "image/svg+xml");
        const textNodes = Array.from(doc.querySelectorAll("text, tspan"));
        const texts = textNodes.map(node => node.textContent.trim()).filter(Boolean);
        if (texts.length > 0) return texts.join(" ");
      } catch (_) {}
    }
    const matches = svgString.match(/<text[^>]*>([\s\S]*?)<\/text>/gi) || [];
    return matches.map(m => m.replace(/<[^>]+>/g, "").trim()).filter(Boolean).join(" ");
  }

  /**
   * Canvas または ImageBitmap から OCR を試行
   * @param {HTMLCanvasElement|ImageBitmap} canvasOrBitmap 
   * @returns {Promise<string>}
   */
  async detectTextFromCanvasOrBitmap(canvasOrBitmap) {
    if (typeof window !== "undefined" && "TextDetector" in window) {
      try {
        const detector = new window.TextDetector();
        const detectedTexts = await detector.detect(canvasOrBitmap);
        if (detectedTexts && detectedTexts.length > 0) {
          return detectedTexts.map(d => d.rawValue).filter(Boolean).join(" ");
        }
      } catch (_) {}
    }
    return "[Canvas画像]";
  }

  /**
   * マイク音声からテキストを認識（Web Speech API: SpeechRecognition）
   * @param {Object} [options]
   * @param {string} [options.lang='ja-JP'] - 音声認識言語
   * @param {number} [options.timeoutMs=10000] - タイムアウト時間（ミリ秒）
   * @returns {Promise<string>} 認識されたテキスト
   */
  async recognizeSpeech(options = {}) {
    if (typeof window === 'undefined') return '';

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      throw new Error('お使いのブラウザは Web Speech API (音声認識) をサポートしていません。最新の Chrome でお試しください。');
    }

    const recognition = new SpeechRecognition();
    recognition.lang = options.lang || 'ja-JP';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    return new Promise((resolve, reject) => {
      let isResolved = false;
      const timeoutId = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          try { recognition.stop(); } catch (_) {}
          reject(new Error('音声認識がタイムアウトしました。マイクに向かって発話してください。'));
        }
      }, options.timeoutMs || 10000);

      recognition.onresult = (event) => {
        if (isResolved) return;
        isResolved = true;
        clearTimeout(timeoutId);
        const transcript = event.results[0]?.[0]?.transcript || '';
        resolve(transcript.trim());
      };

      recognition.onerror = (event) => {
        if (isResolved) return;
        isResolved = true;
        clearTimeout(timeoutId);
        reject(new Error(`音声認識エラー: ${event.error}`));
      };

      recognition.onnomatch = () => {
        if (isResolved) return;
        isResolved = true;
        clearTimeout(timeoutId);
        resolve('');
      };

      recognition.start();
    });
  }

  /**
   * マイク音声からテキストを認識して直接AI判定を実行
   * @param {Choice[]|HTMLSelectElement|string} choices - 判定候補またはselect要素
   * @param {Object} [options]
   * @param {string} [options.speechLang='ja-JP'] - 音声認識言語
   * @param {boolean} [options.includeReason=false] - 理由を出力するか（デフォルト: false・値のみ返却）
   * @returns {Promise<JudgementResult & { speechTranscript: string }>}
   */
  async judgeFromSpeech(choices, options = {}) {
    const transcript = await this.recognizeSpeech({
      lang: options.speechLang || 'ja-JP',
      timeoutMs: options.speechTimeoutMs || 10000,
    });

    if (!transcript || transcript.trim().length === 0) {
      throw new Error('音声が検出されませんでした。');
    }

    console.log('[nano-judgement] 音声認識結果:', transcript);

    const result = await this.judge(choices, transcript, options);
    return {
      ...result,
      isSpeechInput: true,
      speechTranscript: transcript,
    };
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
   * 選択肢の言語を判定し、必要に応じて英語に翻訳して、
   * 元の選択肢と翻訳された選択肢の組み合わせ（ペア）を保持・返却する
   * @param {Choice[]} choices 
   * @returns {Promise<{
   *   originalChoices: Choice[],
   *   translatedChoices: Choice[],
   *   pairMap: Map<string, { original: Choice, translated: Choice }>
   * }>}
   */
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
      // 選択肢の言語判定
      const textToDetect = `${c.name} ${c.description || ''}`.trim();
      const lang = await this.detectLanguage(textToDetect);

      let nameEn = c.name;
      let descriptionEn = c.description;

      // 英語以外の場合は Translator API で英訳
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

    // 通常の前方一致で見つからなかった場合:
    // 入力された文字列が8文字以上の場合、文字数を1〜3文字減らして前方一致するものがないか確認し一時回答とする
    const inputLen = currentContext.length;
    if (inputLen >= 8) {
      for (let delta = 1; delta <= 3; delta++) {
        const shrunkContext = currentContext.slice(0, inputLen - delta);
        const shrunkLen = shrunkContext.length;
        if (shrunkLen < 1) break;

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

          // キャッシュの文章が極端に短くないかチェック
          if (cachedLen <= 5) continue;

          // 前方一致判定:
          // キャッシュされた文章が末尾1〜3文字減らした文章で始まる、またはその逆
          const match1 = cachedContext.startsWith(shrunkContext);
          const match2 = shrunkContext.startsWith(cachedContext);

          if (match1 || match2) {
            // LRUインデックスを最新（末尾）へ更新
            if (typeof window !== "undefined") {
              try {
                let updatedList = this.getIndexList().filter(k => k !== key);
                updatedList.push(key);
                this.saveIndexList(updatedList);
              } catch (_) {}
            }

            console.log(`[nano-judgement] 前方一致(末尾${delta}文字縮小)でキャッシュ一時ヒット: "${currentContext}" -> "${shrunkContext}" (キャッシュ: "${cachedContext}")`);

            return {
              ...cached,
              fromCache: true,
              inferredFromCache: true,
              shrunkChars: delta,
              inferredContext: shrunkContext,
            };
          }
        }
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
   * @param {string[]} [modalities=[]] - 期待する入力モダリティ（例: ['image'], ['audio']）
   */
  async initSession(modalities = []) {
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

    // マルチモーダル指定（画像や音声ファイルそのものを渡す場合）
    if (modalities && modalities.length > 0) {
      const expectedInputs = [{ type: "text" }, ...modalities.map(m => ({ type: m }))];
      try {
        const mmSession = await languageModel.create({
          ...sessionOptions,
          expectedInputs,
        });
        return mmSession;
      } catch (e) {
        console.warn("[nano-judgement] expectedInputs によるマルチモーダルセッション作成に失敗したため通常セッションで再試行します:", e);
      }
    }

    if (this.session) return this.session;
    this.session = await languageModel.create(sessionOptions);
    return this.session;
  }

  /**
   * 判定用プロンプトを構築する
   * @param {Choice[]} choices 
   * @param {string|Record<string, any>} context 
   * @param {boolean} includeReason
   * @param {string} [targetLang='ja']
   * @returns {string}
   */
  buildPrompt(choices, context, includeReason = false, targetLang = 'ja') {
    const formattedChoices = choices.map((c) => {
      let desc = c.name;
      if (c.description) desc += ` - ${c.description}`;
      if (c.metadata) desc += ` (${JSON.stringify(c.metadata)})`;
      return `[${c.id}] ${desc}`;
    }).join("\n");

    const contextStr = typeof context === "string" ? context : JSON.stringify(context);

    const isJa = targetLang === 'ja';
    const reasonPlaceholder = isJa ? "<日本語での簡潔な判断理由>" : `<brief reason in ${targetLang}>`;
    const reasonInstruction = isJa
      ? `You MUST include ALL ${choices.length} choices in the rankings array with confidence scores and brief reasons in natural Japanese (日本語).`
      : `You MUST include ALL ${choices.length} choices in the rankings array with confidence scores and brief reasons in ${targetLang}.`;

    const exampleRankings = choices.map(c => 
      includeReason 
        ? `    { "id": "${c.id}", "confidence": 0.33, "reason": "${reasonPlaceholder}" }`
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
Evaluate ALL choices against context. ${reasonInstruction}
Use strict JSON syntax with commas (never use semicolons).
Output pure JSON only without markdown formatting:
{
  "topChoiceId": "<id>",
  "summaryReason": "${reasonPlaceholder}",
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

    // ファイル（File, Blob, HTMLImageElement, HTMLCanvasElement 等）のポリモーフィック処理
    let resolvedContext = context;
    let fileSource = null;
    let fileModality = null; // 'text' | 'image' | 'audio'
    let isFileInput = false;
    let fileName = '';
    let extractedImageText = '';

    if (typeof Blob !== 'undefined' && context instanceof Blob) {
      isFileInput = true;
      fileSource = context;
      fileName = context.name || 'blob';
      const mimeType = (context.type || '').toLowerCase();

      const isTextFile = (
        mimeType.startsWith('text/') ||
        mimeType === 'application/json' ||
        mimeType === 'application/csv' ||
        /\.(txt|md|markdown|json|csv|tsv|log|html|xml|js|ts|py|yaml|yml)$/i.test(fileName)
      );

      if (isTextFile) {
        fileModality = 'text';
        try {
          resolvedContext = await context.text();
        } catch (e) {
          console.warn('[nano-judgement] テキストファイルの読み込みエラー:', e);
          resolvedContext = `[テキストファイル: ${fileName}]`;
        }
      } else if (mimeType.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|aac|flac)$/i.test(fileName)) {
        fileModality = 'audio';
      } else {
        fileModality = 'image';
      }
    } else if (typeof HTMLImageElement !== 'undefined' && context instanceof HTMLImageElement) {
      isFileInput = true;
      fileModality = 'image';
      fileSource = context;
      fileName = context.src ? context.src.split('/').pop().split('?')[0] : 'image';
    } else if (typeof HTMLCanvasElement !== 'undefined' && context instanceof HTMLCanvasElement) {
      isFileInput = true;
      fileModality = 'image';
      fileSource = context;
      fileName = 'canvas';
    } else if (typeof context === 'string' && (/\.(png|jpe?g|webp|svg|gif)(\?.*)?$/i.test(context) || context.startsWith('data:image/'))) {
      isFileInput = true;
      fileModality = 'image';
      fileName = context.split('/').pop().split('?')[0] || 'image';
    }

    const isImageInput = fileModality === 'image';

    if (options.signal && options.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const includeReason = options.includeReason !== undefined ? options.includeReason : this.options.includeReason;
    const useCache = options.useCache !== undefined ? options.useCache : this.options.enableCache;
    const cacheContextKey = typeof resolvedContext === 'string' ? resolvedContext : (fileName || 'file_input');
    const cacheKey = this.generateCacheKey(choices, cacheContextKey, includeReason);

    // キャッシュチェック
    if (useCache) {
      // 1. 完全一致キャッシュ
      const cached = this.getFromCache(cacheKey);
      if (cached) {
        if (includeReason && cached.summaryReason && !/[ぁ-んァ-ヶ一-龠々]/.test(cached.summaryReason)) {
          const lang = await this.detectLanguage(cacheContextKey);
          if (lang === 'ja') {
            cached.summaryReason = await this.translateText(cached.summaryReason, 'ja');
            if (Array.isArray(cached.rankings)) {
              for (const r of cached.rankings) {
                if (r.reason && !/[ぁ-んァ-ヶ一-龠々]/.test(r.reason)) {
                  r.reason = await this.translateText(r.reason, 'ja');
                }
              }
            }
            this.setCache(cacheKey, cached);
          }
        }
        return cached;
      }

      // 2. 前方一致類推キャッシュ（元の文章が10文字超え、かつ5文字以内の揺らぎ）
      if (typeof resolvedContext === 'string') {
        const inferred = this.findPrefixMatchCache(choices, resolvedContext, includeReason);
        if (inferred) {
          if (includeReason && inferred.summaryReason && !/[ぁ-んァ-ヶ一-龠々]/.test(inferred.summaryReason)) {
            const lang = await this.detectLanguage(resolvedContext);
            if (lang === 'ja') {
              inferred.summaryReason = await this.translateText(inferred.summaryReason, 'ja');
              if (Array.isArray(inferred.rankings)) {
                for (const r of inferred.rankings) {
                  if (r.reason && !/[ぁ-んァ-ヶ一-龠々]/.test(r.reason)) {
                    r.reason = await this.translateText(r.reason, 'ja');
                  }
                }
              }
            }
          }
          return inferred;
        }
      }
    }

    // 3. 既に同一条件の先行判定が実行中の場合は、二重実行せずその完了を待つ（先行判定との合流）
    if (this.inflightJudgements.has(cacheKey)) {
      return await this.inflightJudgements.get(cacheKey);
    }

    const execute = async () => {
      // 根拠（判断理由）を返す場合: 入力されたテキストを Language Detector API で言語判定
      let detectedLang = 'ja';
      if (includeReason) {
        const textToDetect = (typeof context === 'string' && context.trim().length > 0)
          ? context.trim()
          : (typeof resolvedContext === 'string' && resolvedContext.trim().length > 0 ? resolvedContext.trim() : '');

        if (options.targetLang) {
          detectedLang = options.targetLang;
        } else if (textToDetect) {
          detectedLang = await this.detectLanguage(textToDetect);
          console.log(`[nano-judgement] Language Detector API により入力言語を判定: ${detectedLang}`);
        }
      }

      // 選択肢の言語判定・翻訳を行い、元の選択肢と翻訳された選択肢のペアを保持
      const choicePairs = await this.translateAndPairChoices(choices);

      let promptText = this.buildPrompt(
        choicePairs.translatedChoices, 
        typeof resolvedContext === 'string' ? resolvedContext : `[File: ${fileName}]`, 
        includeReason,
        detectedLang
      );

      if (options.signal && options.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      let rawResponse;
      let usedDirectMultimodal = false;

      // 1. 【Gemini Nano マルチモーダル直接渡し】ファイルそのものを直接渡して判定
      if (fileSource && (fileModality === 'image' || fileModality === 'audio')) {
        try {
          const multimodalSession = await this.initSession([fileModality]);
          // Prompt API マルチモーダル形式1 (Content Array 仕様)
          try {
            rawResponse = await multimodalSession.prompt([
              {
                role: 'user',
                content: [
                  { type: 'text', value: promptText },
                  { type: fileModality, value: fileSource }
                ]
              }
            ]);
            usedDirectMultimodal = true;
            console.log(`[nano-judgement] ✅ Gemini Nano に${fileModality === 'image' ? '画像' : '音声'}ファイルそのものを直接渡してマルチモーダル判定に成功しました！`);
          } catch (err1) {
            // Prompt API マルチモーダル形式2 (フラット配列 仕様)
            rawResponse = await multimodalSession.prompt([
              { type: 'text', content: promptText },
              { type: fileModality, content: fileSource }
            ]);
            usedDirectMultimodal = true;
            console.log(`[nano-judgement] ✅ Gemini Nano に${fileModality === 'image' ? '画像' : '音声'}ファイルそのものを直接渡してマルチモーダル判定に成功しました (形式2)！`);
          }
        } catch (multiModalErr) {
          console.warn(`[nano-judgement] Gemini Nano へのファイル直接渡し（マルチモーダル入力）が非対応環境またはエラーのため、オンデバイスOCR/解析フォールバックで実行します:`, multiModalErr);
        }
      }

      // 2. マルチモーダル直接渡しが未実行または失敗した場合: テキスト抽出フォールバック
      if (!rawResponse) {
        if (fileModality === 'image' && (!extractedImageText || typeof resolvedContext !== 'string')) {
          extractedImageText = await this.extractTextFromImage(fileSource || context);
          resolvedContext = extractedImageText || `[画像ファイル: ${fileName}]`;
          promptText = this.buildPrompt(choicePairs.translatedChoices, resolvedContext, includeReason, detectedLang);
        }

        const textSession = await this.initSession();
        try {
          rawResponse = await textSession.prompt(promptText);
        } catch (err) {
          this.destroy();
          throw err;
        }
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

      // 根拠（判断理由）を返す場合: 入力されたテキストの言語へ Translator API（またはフォールバック）で翻訳して戻す
      let summaryReason = undefined;
      let rankings = [];

      if (includeReason) {
        // 全体判断サマリー（根拠）を Translator API で入力言語へ翻訳
        if (parsed.summaryReason) {
          summaryReason = await this.translateText(parsed.summaryReason, detectedLang);
          console.log(`[nano-judgement] Translator API により根拠を翻訳 (${detectedLang}):`, summaryReason);
        }

        // 各選択肢の個別理由も Translator API で入力言語へ翻訳
        rankings = await Promise.all(rawRankings.map(async (r) => {
          const pair = originalChoiceMap.get(r.id);
          const original = pair ? pair.original : null;
          let reason = undefined;

          if (r.reason) {
            reason = await this.translateText(r.reason, detectedLang);
          }

          return {
            id: r.id,
            name: original ? original.name : r.id,
            confidence: typeof r.confidence === "number" ? r.confidence : 0,
            ...(reason ? { reason } : {}),
          };
        }));
      } else {
        // 根拠なし（最速モード）: 翻訳 API を呼び出さずそのまま確率と選択肢名のみマッピング
        rankings = rawRankings.map((r) => {
          const pair = originalChoiceMap.get(r.id);
          const original = pair ? pair.original : null;
          return {
            id: r.id,
            name: original ? original.name : r.id,
            confidence: typeof r.confidence === "number" ? r.confidence : 0,
          };
        });
      }

      rankings.sort((a, b) => b.confidence - a.confidence);

      const contextStr = typeof resolvedContext === "string" ? resolvedContext.trim() : JSON.stringify(resolvedContext);
      const normalizedContext = this.normalizeTextForCache(contextStr);
      const choicesKey = choices.map(c => `${c.id}:${c.name}:${c.description || ''}`).sort().join("|");

      const result = {
        context: normalizedContext,
        rawContext: contextStr,
        choicesKey,
        topChoice,
        rankings,
        ...(includeReason && summaryReason ? { summaryReason } : {}),
        ...(includeReason ? { detectedLanguage: detectedLang } : {}),
        rawResponse,
        fromCache: false,
        isFileInput,
        isDirectMultimodal: usedDirectMultimodal,
        ...(fileModality ? { inputModality: fileModality } : {}),
        ...(fileName ? { inputFileName: fileName } : {}),
        isImageInput,
        ...(extractedImageText ? { extractedImageText } : {}),
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

  /**
   * 入力内容を事前に判定開始（投機的先行実行 / Pre-judgement）する。
   * ボタン押下前に裏側で非同期に計算を走らせ、ボタン押下時の待ち時間をゼロ（0ms）または最小化する。
   * @param {Choice[]|HTMLSelectElement|string} choices 
   * @param {string|Record<string, any>} context 
   * @param {Object} [options] 
   * @returns {Promise<JudgementResult>}
   */
  preJudge(choices, context, options = {}) {
    return this.judge(choices, context, options);
  }

  /**
   * 指定した条件の判定が現在実行中（先行判定中）かどうかを確認する
   * @param {Choice[]|HTMLSelectElement|string} choices 
   * @param {string|Record<string, any>} context 
   * @param {boolean} [includeReason=false] 
   * @returns {boolean}
   */
  isJudging(choices, context, includeReason = false) {
    const cacheKey = this.generateCacheKey(choices, context, includeReason);
    return this.inflightJudgements.has(cacheKey);
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
        revalidateTimer: null,
        revalidateAbortController: null,
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

      // 判定開始イベントを発火（画面描画・スピナー表示はHTML側の責務）
      element.dispatchEvent(new CustomEvent('nano-judgement-start', {
        detail: { element, textToJudge, selectElement: selectEl },
        bubbles: true,
      }));

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

        // 入力テキストを使って判定（言語判定パイプラインを正確に動作させる）
        const result = await this.judge(currentChoices, textToJudge, {
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

        element.dispatchEvent(new CustomEvent('nano-judgement-complete', {
          detail: { result, element, choices: currentChoices, fromCache: result.fromCache, selectElement: selectEl },
          bubbles: true,
        }));

        // -------------------------------------------------------------
        // 【要件1 & 2】前方一致類推キャッシュ時のバックグラウンド再検証 (Stale-While-Revalidate)
        // 1. タイピング停止後のデバウンス（800ms）を待ってから裏側で最新文章に対する本判定を実行
        // 2. 結果（最有力候補）が変わった時だけ画面（セレクトボックス / イベント）を更新
        // -------------------------------------------------------------
        const revalidateEnabled = this.options.revalidateOnPrefixMatch !== false;
        if (revalidateEnabled && result.inferredFromCache) {
          if (sessionState.revalidateTimer) clearTimeout(sessionState.revalidateTimer);
          if (sessionState.revalidateAbortController) {
            sessionState.revalidateAbortController.abort();
            sessionState.revalidateAbortController = null;
          }

          const debounceMs = this.options.revalidateDebounceMs || 800;

          sessionState.revalidateTimer = setTimeout(async () => {
            if (myGeneration !== sessionState.currentGeneration) return;

            const revalidateController = new AbortController();
            sessionState.revalidateAbortController = revalidateController;

            try {
              console.log(`[nano-judgement] 前方一致キャッシュ検証: タイピング停止(${debounceMs}ms)を検知。裏側で本判定を開始します ("${textToJudge}")`);

              const exactCacheKey = this.generateCacheKey(currentChoices, textToJudge, includeReason);
              let freshResult = this.getFromCache(exactCacheKey);

              if (!freshResult) {
                freshResult = await this.judge(currentChoices, textToJudge, {
                  includeReason,
                  targetLang,
                  useCache: false, // 類推キャッシュをバイパスして新規計算
                  signal: revalidateController.signal,
                });
                if (this.options.enableCache) {
                  this.setCache(exactCacheKey, freshResult);
                }
              }

              if (myGeneration !== sessionState.currentGeneration) return;

              const previousTopId = result.topChoice?.id;
              const newTopId = freshResult.topChoice?.id;
              const topChoiceChanged = previousTopId !== newTopId;

              // 1. 順序の変更チェック（全ランキングの並び順）
              const prevOrder = (result.rankings || []).map(r => r.id);
              const newOrder = (freshResult.rankings || []).map(r => r.id);
              const orderChanged = prevOrder.length !== newOrder.length || prevOrder.some((id, idx) => id !== newOrder[idx]);

              // 2. それぞれのスコアが20%以上変動したかチェック
              const scoreThreshold = this.options.revalidateScoreThreshold !== undefined ? this.options.revalidateScoreThreshold : 0.20;
              let scoreShifted = false;
              let shiftedDetail = '';

              const prevScoreMap = new Map();
              (result.rankings || []).forEach(r => {
                prevScoreMap.set(r.id, typeof r.confidence === 'number' ? r.confidence : 0);
              });

              for (const r of (freshResult.rankings || [])) {
                const prevScore = prevScoreMap.has(r.id) ? prevScoreMap.get(r.id) : 0;
                const newScore = typeof r.confidence === 'number' ? r.confidence : 0;
                const diff = Math.abs(newScore - prevScore);

                // スコアの差分が閾値（20% = 0.20）以上、または相対変動20%以上かつ有意な変化（>= 0.05）
                if (diff >= scoreThreshold || (prevScore > 0 && (diff / prevScore) >= scoreThreshold && diff >= 0.05)) {
                  scoreShifted = true;
                  shiftedDetail = `[${r.id}] ${Math.round(prevScore * 100)}% → ${Math.round(newScore * 100)}% (差分: ${Math.round(diff * 100)}%)`;
                  break;
                }
              }

              const isChanged = topChoiceChanged || orderChanged || scoreShifted;

              // 結果に変更（最有力候補 / 順序 / スコア20%以上変動）があった時だけ画面を更新
              if (isChanged) {
                let changeReason = '';
                if (topChoiceChanged) changeReason = `最有力候補の変化 [${previousTopId}] → [${newTopId}]`;
                else if (orderChanged) changeReason = `順序の変化 [${prevOrder.join(' > ')}] → [${newOrder.join(' > ')}]`;
                else if (scoreShifted) changeReason = `スコアの20%以上変動 (${shiftedDetail})`;

                console.log(`[nano-judgement] 本判定による画面更新を検知: ${changeReason}。画面を最新化します。`);

                if (selectEl && shouldAutoSelect && freshResult.topChoice) {
                  if (selectEl.value !== freshResult.topChoice.id) {
                    selectEl.value = freshResult.topChoice.id;
                    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                }

                element.dispatchEvent(new CustomEvent('nano-judgement-complete', {
                  detail: {
                    result: freshResult,
                    element,
                    choices: currentChoices,
                    fromCache: false,
                    revalidated: true,
                    changeReason,
                    selectElement: selectEl,
                  },
                  bubbles: true,
                }));
              } else {
                console.log(`[nano-judgement] 本判定完了: 最有力候補・順序・各スコア（20%未満）ともに実質同一のため、チラつき防止でキャッシュ更新のみ完了。`);
                element.dispatchEvent(new CustomEvent('nano-judgement-revalidated', {
                  detail: {
                    result: freshResult,
                    element,
                    choices: currentChoices,
                    changed: false,
                    selectElement: selectEl,
                  },
                  bubbles: true,
                }));
              }
            } catch (err) {
              if (err.name !== 'AbortError') {
                console.warn('[nano-judgement] バックグラウンド本判定エラー:', err);
              }
            } finally {
              if (sessionState.revalidateAbortController === revalidateController) {
                sessionState.revalidateAbortController = null;
              }
            }
          }, debounceMs);
        }
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

    // <button data-nano-judgement-speech> または button 要素の場合: クリックで音声認識＆判定
    if (element.tagName === 'BUTTON' || element.hasAttribute('data-nano-judgement-speech')) {
      const handleSpeechClick = async (e) => {
        if (e) e.preventDefault();
        element.setAttribute('data-judge-status', 'listening');
        element.dispatchEvent(new CustomEvent('nano-judgement-speech-start', {
          detail: { element },
          bubbles: true,
        }));

        try {
          const speechLang = element.getAttribute('data-judge-speech-lang') || 'ja-JP';
          const reasonAttr = element.getAttribute('data-judge-reason');
          const includeReason = reasonAttr === 'true' ? true : (reasonAttr === 'false' ? false : this.options.includeReason);
          const currentChoices = typeof choices === 'function' ? choices() : choices;

          const result = await this.judgeFromSpeech(currentChoices, {
            speechLang,
            includeReason,
            selectElement: selectEl,
            autoSelect: element.getAttribute('data-judge-auto-select') !== 'false',
          });

          element.setAttribute('data-judge-status', 'complete');
          element.dispatchEvent(new CustomEvent('nano-judgement-complete', {
            detail: {
              element,
              result,
              fromCache: result.fromCache,
              selectElement: selectEl,
              isSpeech: true,
              speechTranscript: result.speechTranscript
            },
            bubbles: true,
          }));
        } catch (err) {
          element.setAttribute('data-judge-status', 'error');
          element.dispatchEvent(new CustomEvent('nano-judgement-speech-error', {
            detail: { element, error: err },
            bubbles: true,
          }));
          console.error('[nano-judgement] 音声認識・判定エラー:', err);
        }
      };

      element.removeEventListener('click', element._nanoJudgeSpeechHandler);
      element._nanoJudgeSpeechHandler = handleSpeechClick;
      element.addEventListener('click', handleSpeechClick);
      return;
    }

    // <input type="file"> の場合: ファイル選択イベント (change) を監視
    if (element.tagName === 'INPUT' && element.type === 'file') {
      const handleFileChange = async () => {
        const file = element.files && element.files[0];
        if (!file) return;

        element.setAttribute('data-judge-status', 'pending');
        element.dispatchEvent(new CustomEvent('nano-judgement-started', {
          detail: { element, file },
          bubbles: true,
        }));

        try {
          const currentChoices = typeof choices === 'function' ? choices() : choices;
          const reasonAttr = element.getAttribute('data-judge-reason');
          const includeReason = reasonAttr === 'true' ? true : (reasonAttr === 'false' ? false : this.options.includeReason);

          const result = await this.judge(currentChoices, file, {
            includeReason,
            selectElement: selectEl,
            autoSelect: element.getAttribute('data-judge-auto-select') !== 'false',
          });

          element.setAttribute('data-judge-status', 'complete');
          element.dispatchEvent(new CustomEvent('nano-judgement-complete', {
            detail: {
              element,
              result,
              file,
              fromCache: result.fromCache,
              selectElement: selectEl,
            },
            bubbles: true,
          }));
        } catch (err) {
          element.setAttribute('data-judge-status', 'error');
          console.error('[nano-judgement] ファイル直接判定エラー:', err);
        }
      };

      element.removeEventListener('change', element._nanoJudgeFileHandler);
      element._nanoJudgeFileHandler = handleFileChange;
      element.addEventListener('change', handleFileChange);
      return;
    }

    // <img> 要素の場合: src の変更やロード完了を監視
    if (element.tagName === 'IMG') {
      const handleImage = async () => {
        element.setAttribute('data-judge-status', 'pending');
        element.dispatchEvent(new CustomEvent('nano-judgement-started', {
          detail: { element },
          bubbles: true,
        }));

        try {
          const currentChoices = typeof choices === 'function' ? choices() : choices;
          const reasonAttr = element.getAttribute('data-judge-reason');
          const includeReason = reasonAttr === 'true' ? true : (reasonAttr === 'false' ? false : this.options.includeReason);

          const result = await this.judge(currentChoices, element, {
            includeReason,
            selectElement: selectEl,
            autoSelect: element.getAttribute('data-judge-auto-select') !== 'false',
          });

          element.setAttribute('data-judge-status', 'complete');
          element.dispatchEvent(new CustomEvent('nano-judgement-complete', {
            detail: {
              element,
              result,
              fromCache: result.fromCache,
              selectElement: selectEl,
            },
            bubbles: true,
          }));
        } catch (err) {
          element.setAttribute('data-judge-status', 'error');
          console.error('[nano-judgement] <img> 要素判定エラー:', err);
        }
      };

      element.removeEventListener('load', element._nanoJudgeImgLoadHandler);
      element._nanoJudgeImgLoadHandler = handleImage;
      element.addEventListener('load', handleImage);

      if (element.complete && element.src) {
        handleImage();
      }
      return;
    }

    // 入力イベントハンドラ
    const handleInput = async () => {
      const rawText = ('value' in element ? element.value : element.textContent || '');
      const cleanText = rawText.replace(/[\s\u3000]+/g, '');

      // スペースなどを削除して0文字になったら判定を即時停止＆リセット
      if (cleanText.length === 0) {
        if (sessionState.revalidateTimer) {
          clearTimeout(sessionState.revalidateTimer);
          sessionState.revalidateTimer = null;
        }
        if (sessionState.revalidateAbortController) {
          sessionState.revalidateAbortController.abort();
          sessionState.revalidateAbortController = null;
        }
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

      // 5文字未満の場合はスキップ
      if (currentText.length < 5) {
        return;
      }

      // 新たな入力があった場合は進行中のバックグラウンド再検証をリセット
      if (sessionState.revalidateTimer) {
        clearTimeout(sessionState.revalidateTimer);
        sessionState.revalidateTimer = null;
      }
      if (sessionState.revalidateAbortController) {
        sessionState.revalidateAbortController.abort();
        sessionState.revalidateAbortController = null;
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

    const selector = scanOptions.selector || '[data-nano-judgement], [data-nano-judgement-speech]';
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
