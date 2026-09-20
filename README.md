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

---

## HTML属性オプション一覧

| 属性 | 説明 | 例 |
|---|---|---|
| `data-nano-judgement` | 自動判定対象の入力要素であることを示すフラグ | `<textarea data-nano-judgement>` |
| `data-judge-select` | 連動する `<select>` 要素のセレクタ。選択肢を自動抽出し、判定結果に合わせて `<select>` を自動選択（Auto-select） | `data-judge-select="#mySelect"` |
| `data-judge-auto-select` | セレクトボックス連動時、最有力候補を自動選択するか（デフォルト: `true`） | `data-judge-auto-select="false"` |
| `data-judge-target` | HTML側スクリプトが描画先コンテナを特定するための要素セレクタ（ライブラリは画面描画を行わずイベントを発火するため、HTML側で自由に描画可能） | `data-judge-target="#result-1"` |
| `data-judge-reason` | `true` の場合、判定理由を出力し Chrome の **Translator API** で入力言語に自動翻訳（省略時は `false` で理由を省き確率のみ超高速出力） | `data-judge-reason="true"` |
| `data-judge-lang` | 理由翻訳先の言語コード（省略時はコンテキストから自動検出: 例 `'ja'`） | `data-judge-lang="ja"` |
| `data-judge-choices` | 要素専用の選択肢リスト（JSON文字列、または選択肢JSON/`<select>`を含む要素セレクタ） | `data-judge-choices='[{"id":"A","name":"..."}]'` または `data-judge-choices="#mySelect"` |

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

## Chrome での事前準備（Prompt API の有効化）

1. 最新版の **Google Chrome** を起動
2. アドレスバーに `chrome://flags` を入力して開く
3. 以下のフラグを設定：
   - `#prompt-api-for-gemini-nano` → **Enabled**
   - `#optimization-guide-on-device-model` → **Enabled BypassPerfRequirement**
4. Chrome を再起動
5. `chrome://components` を開き、**Optimization Guide On Device Model** の「アップデートを確認」をクリックしてモデルがダウンロードされていることを確認（バージョン番号が表示されていれば完了）
