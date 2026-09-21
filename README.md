# nano-judgement.js

Chrome の組み込み AI（Gemini Nano）を動かす **Prompt API**（`window.LanguageModel` / `window.ai.languageModel`）を利用して、与えられた文脈（状況・条件）と複数の選択肢の中から「最も可能性・妥当性が高い選択肢」をブラウザ内で完全ローカルに判定する軽量 JavaScript ライブラリです。

---

## 主な特徴

- ⚡ **サーバー不要・完全オンデバイス**: サーバーへの API 問い合わせや API キーが不要。プライバシーを保護しつつオフライン・低遅延で判定。
- 🎯 **構造化された確信度スコア**: 速度優先の確率のみ判定（デフォルト）と、Translator API による翻訳付き理由出力（フラグ指定時）の両方に対応。
- 🧠 **5文字入力からのプロアクティブ事前翻訳 ＆ 判定**:
  - テキストが5文字以上入力された時点で、**Language Detector API** と **Translator API** により英語へ自動翻訳し個別にキャッシュ。
  - バックグラウンドで事前の判定を即座に開始。
  - **2秒以内の再更新**: 英語に都度翻訳し、先ほどの文章とは別キーで安全にキャッシュ。
  - **2秒経過後の更新**: 最初の文章から **25%以上テキストが変化した場合**、進行中の判定を中断して最新テキストで再判定。
- 🔄 **判定結果の自動キャッシュ（最新1000世代 ＆ 前方一致類推）**:
  - **スペース・句読点の自動正規化**: キャッシュ保存時および判定照合時、全角・半角スペースや改行、一般的な句読点（`、` `。` `,` `.` `!` `?` など）を省いて判定・保存します。句読点の有無や空白の差による無駄な再判定を防ぎ、キャッシュヒット率を大幅に向上させます。
  - 同一の「入力文」＋「選択肢」の判定結果を自動保存（sessionStorage/メモリ）。リロード時や再評価時はゼロ秒で即座に結果を復元。
  - **前方一致による類推キャッシュ**: キャッシュされた元の文章が10文字を超えている場合、前方一致するキャッシュと「キャッシュから5文字減らした文章」の間に入力文がある場合（±5文字以内の微修正・入力途中）、過去のキャッシュ結果を自動類推して即座に再利用します。
  - **最新1000世代まで保存**: LRU（Least Recently Used）アルゴリズムを採用し、アクセスされたキャッシュを自動昇格。1000世代を超過した古いキャッシュから自動削除されるため、ストレージを圧迫しません。
- 🪄 **HTML属性による即時自動判定**: 入力枠に `data-nano-judgement` 属性を付けるだけで、初期テキストがある場合にスクリプト読み込み直後に自動判定開始。
- 🗂️ **複数入力枠の並列対応**: 1ページ内に複数の判定フォームが存在しても、それぞれ独立して判定・結果紐付けが可能。
- 🌐 **GitHub Pages 対応**: リポジトリのルートにサンプルページ（`index.html`）を配置しているため、GitHub Pages で即座にデモを公開可能。

---

## ページへの組み込みと使い方

### パターン 1: HTML属性による即時自動判定（推奨）

入力枠（`<textarea>` や `<input>`）に `data-nano-judgement` 属性を付与します。
JavaScript が読み込まれた時点でテキストが既に入っていれば、**即座に自動判定が開始**され、結果がキャッシュされます。

```html
<!-- スクリプトの読み込み -->
<script src="./nano-judgement.global.js"></script>

<!-- 案件1: 共通選択肢を使用 -->
<textarea 
  data-nano-judgement 
  data-judge-target="#result-1"
>予算はほぼゼロだが来週までに実動プロトタイプが必要</textarea>
<div id="result-1"></div>

<!-- 案件2: 独自の選択肢をJSONで指定 -->
<textarea 
  data-nano-judgement 
  data-judge-target="#result-2"
  data-judge-choices='[
    {"id":"A","name":"マネージドクラウド","description":"高可用性・低運用負荷"},
    {"id":"B","name":"自前オンプレミス","description":"初期コストのみだが運用負荷大"}
  ]'
>24時間365日の連続稼働が必須の基幹システム</textarea>
<!-- 案件3: セレクトボックスと連動（選択肢の自動抽出 ＆ AIによる自動選択） -->
<select id="prioritySelect">
  <option value="p1" data-description="即時対応が必要な重大問題">緊急 (P1)</option>
  <option value="p2" data-description="通常業務時間内の対応でよい問題">通常 (P2)</option>
  <option value="other" data-description="一般的な問い合わせやその他相談">その他</option>
</select>

<textarea 
  data-nano-judgement 
  data-judge-select="#prioritySelect"
  data-judge-target="#result-3"
>データベースがダウンして決済がすべて停止している</textarea>
<div id="result-3"></div>
```

### パターン 2: JavaScript からプログラマティックに実行

```javascript
import { NanoJudgement } from './nano-judgement.js';

const judgement = new NanoJudgement({
  enableCache: true,          // キャッシュを有効化（デフォルト: true）
  cacheStorage: 'session',    // 'session' (sessionStorage) または 'local' (localStorage)
  maxCacheGenerations: 1000,  // 保存する最大世代数（デフォルト: 1000、超過分は古い順に自動削除）
});

// 通常の配列、または <select> 要素/セレクタを直接指定可能！
const selectEl = document.querySelector('#prioritySelect');
const context = "予算は少ないが、来週までにどうしても急ぎでリリースしたい";

// 判定実行（セレクトボックスから選択肢を自動抽出して判定）
const result = await judgement.judge(selectEl, context);

console.log("最有力候補:", result.topChoice.name);
console.log("判断理由:", result.summaryReason);
console.log("キャッシュヒット:", result.fromCache);
```

### ファイルそのもの（画像/音声/テキスト）を Gemini Nano に直接渡して判定
`judge()` の第2引数（Context）には、テキスト文字列だけでなく `File` や `Blob`、`HTMLImageElement` を**そのまま直接渡す**ことができます。

* **画像・音声ファイル（PNG, JPEG, WebP, SVG, MP3, WAV 等）**:
  Chrome のマルチモーダル Prompt API（`chrome://flags/#prompt-api-for-gemini-nano-multimodal-input`）が有効な環境では、**画像や音声の `File` / `Blob` そのものを Gemini Nano に直接入力**して推論します。非対応環境やフラグ未設定時は、自動でオンデバイス OCR（`window.TextDetector`）/ SVG 解析 / メタデータにフォールバックして処理されます。
* **テキスト系ファイル（`.txt`, `.json`, `.csv`, `.md`, `.log` 等）**:
  ファイルの中身を自動で丸ごと読み取り、Gemini Nano のコンテキストへ直接投入します。

```javascript
// 1. 画像ファイル（File オブジェクト）そのものを直接渡す
const fileInput = document.querySelector('#receiptInput');
const result = await judgement.judge(choices, fileInput.files[0]);

console.log("仕訳判定 (値のみ):", result.topChoice.name);
console.log("マルチモーダル直接判定:", result.isDirectMultimodal); // true (Gemini Nano 直接渡し成功時)

// 2. テキストファイル（.log, .json, .csv 等）そのものを直接渡す
const logFileInput = document.querySelector('#logFileInput');
const logResult = await judgement.judge('#prioritySelect', logFileInput.files[0]);

// 3. 根拠（判断理由）も必要な場合は includeReason: true を渡します
const detailedResult = await judgement.judge(choices, fileInput.files[0], {
  includeReason: true,
});
console.log("判断理由 (根拠):", detailedResult.summaryReason);
```

### 音声入力（マイク音声認識: Web Speech API）の実装方法
Chrome 標準の **Web Speech API**（`webkitSpeechRecognition`）と連携し、マイクからの発話音声をリアルタイムにオンデバイス文字起こしして直接AI判定を実行します。

```javascript
// 1. judgeFromSpeech: 音声認識からAI判定・セレクトボックス連動まで一括実行
const speechResult = await judgement.judgeFromSpeech('#supportPriority', {
  speechLang: 'ja-JP',      // 音声認識言語（デフォルト: 'ja-JP'）
  speechTimeoutMs: 10000,   // 発話待機タイムアウト（ミリ秒）
  includeReason: false,     // デフォルト: false（値のみ高速返却）
});

console.log("話した内容 (テキスト):", speechResult.speechTranscript);
console.log("判定結果:", speechResult.topChoice.name);

// 2. 音声認識テキストのみを単体で取得したい場合
const transcript = await judgement.recognizeSpeech({ lang: 'ja-JP' });
console.log("認識テキスト:", transcript);
```

> **根拠（判断理由）の表示制御について**:
> * **デフォルト（パラメータ省略時）**: 速度優先のため**根拠は生成・表示せず、値（最有力候補・確信度スコア）のみを高速に返却**します。
> * **根拠を求める場合**: `{ includeReason: true }`（JavaScript）または `data-judge-reason="true"`（HTML属性）を指定すると、入力されたテキストを **Language Detector API** で言語判定し、その言語へ **Translator API** で自動翻訳して返却します。

---

### 実践的な実装例（コピペで動作）

#### 1. 📷 領収書・レシート画像のドラッグ＆ドロップ自動仕訳
```html
<div id="dropZone" style="border: 2px dashed #38bdf8; padding: 2rem; text-align: center; cursor: pointer;">
  <p>ここに領収書画像をドラッグ＆ドロップ</p>
  <input type="file" id="receiptInput" accept="image/*" style="display: none;">
</div>

<select id="accountCategory">
  <option value="travel" data-description="電車・タクシー・航空券等の移動交通費">旅費交通費</option>
  <option value="supplies" data-description="PC周辺機器・文具・消耗品">消耗品費</option>
  <option value="entertainment" data-description="会食・カフェでの打合せ代">会議接待費</option>
  <option value="other" data-description="その他の経費">その他</option>
</select>

<script type="module">
  import { NanoJudgement } from './nano-judgement.js';
  const judgement = new NanoJudgement();
  const selectEl = document.getElementById('accountCategory');

  document.getElementById('receiptInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    // Fileオブジェクトをそのまま渡すだけで自動判定＆セレクトボックス選択！
    const result = await judgement.judge(selectEl, file, { includeReason: true });
    console.log('仕訳結果:', selectEl.value, result.summaryReason);
  });
</script>
```

#### 2. 📹 Webカメラ・スマホ撮影レシートの即時キャプチャ判定
```javascript
// カメラから Canvas 経由で Blob を取り出して直接判定
canvas.toBlob(async (blob) => {
  const result = await judgement.judge('#accountCategory', blob);
  console.log('撮影レシートの判定結果:', result.topChoice.name);
}, 'image/jpeg', 0.9);
```

#### 3. 🎙️ マイク音声でのお問い合わせ優先度判定（ノーコード HTML 属性）
```html
<!-- ボタンを押すだけでマイクが起動し、話した内容から緊急度（P0〜P3）を自動判定 -->
<button type="button"
        data-nano-judgement-speech
        data-judge-select="#prioritySelect"
        data-judge-target="#resultCard"
        data-judge-reason="true">
  🎙️ 声で話して優先度を判定
</button>

<select id="prioritySelect">
  <option value="p0" data-description="本番障害、決済停止、全ユーザー影響">P0-緊急</option>
  <option value="p1" data-description="主要機能の不具合">P1-高</option>
  <option value="p2" data-description="軽微な質問・相談">P2-中</option>
  <option value="other" data-description="その他">その他</option>
</select>
<div id="resultCard"></div>
```

#### 4. 🎵 音声ファイル（.mp3, .wav, .m4a）の直接投入判定
```javascript
// コールセンターの録音データなどをそのまま投入
const audioFile = audioInput.files[0];
const result = await judgement.judge(categories, audioFile, { includeReason: true });
console.log('音声仕訳結果:', result.topChoice.name);
```

---

## HTML属性オプション一覧

| 属性 | 説明 | 例 |
|---|---|---|
| `data-nano-judgement` | 自動判定対象の入力要素（`<textarea>`, `<input>`, `<img>`, `<input type="file">`）であることを示すフラグ | `<textarea data-nano-judgement>` |
| `data-nano-judgement-speech` | クリック時にマイク音声認識を起動して自動判定を行うボタン属性 | `<button data-nano-judgement-speech>` |
| `data-judge-select` | 連動する `<select>` 要素のセレクタ。選択肢を自動抽出し、判定結果に合わせて `<select>` を自動選択（Auto-select） | `data-judge-select="#mySelect"` |
| `data-judge-auto-select` | セレクトボックス連動時、最有力候補を自動選択するか（デフォルト: `true`） | `data-judge-auto-select="false"` |
| `data-judge-target` | HTML側スクリプトが描画先コンテナを特定するための要素セレクタ（ライブラリは画面描画を行わずイベントを発火するため、HTML側で自由に描画可能） | `data-judge-target="#result-1"` |
| `data-judge-reason` | `true` の場合、判定理由（根拠）を出力。入力テキストを **Language Detector API** で言語判定し、**Translator API** で自動翻訳して返却（省略時は `false` で理由を省き確率のみ超高速出力） | `data-judge-reason="true"` |
| `data-judge-lang` | 理由翻訳先を手動指定する場合の言語コード（省略時は **Language Detector API** により自動検出） | `data-judge-lang="ja"` |
| `data-judge-speech-lang` | 音声認識の言語コード（省略時は `'ja-JP'`） | `data-judge-speech-lang="ja-JP"` |
| `data-judge-choices` | 要素専用の選択肢リスト（JSON文字列、または選択肢JSON/`<select>`を含む要素セレクタ） | `data-judge-choices='[{"id":"A","name":"..."}]'` または `data-judge-choices="#mySelect"` |

### JS初期化オプション (Stale-While-Revalidate & キャッシュ類推)
```javascript
const judgement = new NanoJudgement({
  // 前方一致キャッシュによる即時応答後、タイピング停止時に裏側で正確な本判定を非同期実行（デフォルト: true）
  revalidateOnPrefixMatch: true,
  // 裏判定のタイピング停止検知ミリ秒（デフォルト: 800ms）
  revalidateDebounceMs: 800,
  // 有意な変化（最有力候補・順序・スコア20%以上変動）があった時のみ画面更新（デフォルト: true）
  revalidateOnlyOnChange: true,
  // スコア変動検知の閾値（デフォルト: 0.20 = 20%）
  revalidateScoreThreshold: 0.20
});
```

> **前方一致類推＆一時回答（Stale-While-Revalidate）の流れ**:
> 1. **通常の前方一致**: 過去の判定キャッシュと前方一致する場合、即座に類推キャッシュとして0msで即時応答。
> 2. **末尾1〜3文字縮小による探索（8文字以上）**: 一致するものがなく入力文字列が8文字以上の場合、末尾を1〜3文字減らして前方一致キャッシュを探索し、見つかった場合は**一時回答**として即時表示。
> 3. **タイピング停止検知（デバウンス 800ms）**: ユーザーがタイピングを停止したタイミングで裏側で最新の全文に対する本判定を実行。
> 4. **差分更新**: 最有力候補（`topChoice.id`）の変化、選択肢の順序の変化、またはいずれかのスコアが20%以上変動した場合のみ画面やセレクトボックスを自動更新し、チラつきなく高精度な結果を反映。

---

## GitHub Pages への公開手順

1. 本リポジトリを GitHub に push します。
   ```bash
   git add .
   git commit -m "feat: Add nano-judgement.js and GitHub Pages sample"
   git push origin main
   ```
2. GitHub リポジトリの **Settings** > **Pages** に移動します。
3. **Build and deployment** の **Source** で `Deploy from a branch` を選択します。
4. **Branch** に `main`、フォルダに `/ (root)` を選択して **Save** をクリックします。
5. `https://<ユーザー名>.github.io/<リポジトリ名>/` にサンプルページが自動公開されます。

---

## Chrome での事前準備（Prompt API 利用ガイド）

Prompt API は通常の **Google Chrome（最新版）** に標準統合されています。最新版をご利用であれば**事前のフラグ変更は原則不要**でそのまま動作します。

1. **Google Chrome を最新版に更新**
   - 特別な flags の変更を行わずにそのまま Prompt API をご利用いただけます。
2. **モデルのダウンロード（初回自動処理）**
   - 初回判定時にオンデバイスモデル（Gemini Nano / 約1〜2GB）が自動ダウンロードされます。
   - 事前に手動でダウンロードを完了させたい場合は、[`chrome://components`](chrome://components) を開き、**Optimization Guide On Device Model** の「アップデートを確認」をクリックしてください（バージョン番号が表示されれば準備完了）。
3. **（補足）動作しない場合・先行機能（マルチモーダル直接渡し等）**
   - 企業の制限ポリシー等で利用できない場合、あるいは画像・音声ファイルを直接渡すマルチモーダル先行入力を試したい場合は、[`chrome://flags`](chrome://flags) を開き以下をご確認ください：
     - `#prompt-api-for-gemini-nano` → **Enabled**
     - `#prompt-api-for-gemini-nano-multimodal-input` → **Enabled**（画像・音声ファイルの直接渡し用）
     - `#optimization-guide-on-device-model` → **Enabled BypassPerfRequirement**
     - `#translation-api` → **Enabled**（判断理由の多言語自動翻訳用）
