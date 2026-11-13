# 造句対戦（Grame）

AIと交互に中国語の単語を1つずつ追加して文を作る、対戦ゲーム。

## ルール

- プレイヤーとAIが交互に **1単語** を文の末尾に追加する
- 追加した単語で **文法が破綻したら、破綻させた側の負け**
- 文を完成させて、相手が自然に続けられなくなったら **完成させた側の勝ち**
- 例：我 → 是 → 学生 → 的 → …（「我是学生的…」と育てていく）

## 遊び方

`index.html` をブラウザで開くだけ。Vercel にデプロイ済み：
https://grame-blond.vercel.app/

### モード

- **文法モード（キー不要）**：辞書CSV（`lexicon.csv`、約350語・品詞タグ付き）と文法ルール
  （有限状態の語順パターン）で判定するオフライン対戦。決まった例文には縛られず、
  辞書の語彙の範囲で自由に文を作れる。CSVに行を足せば語彙が増える。
  辞書にない語は「辞書外」として破綻扱いになる。
- **AI対戦モード**：APIキーはブラウザに置かず、サーバーの**環境変数**で管理する。
  Vercel の Project → Settings → Environment Variables で設定：
  - `GRAME_API_KEY`（必須）：Groq などの OpenAI 互換 API キー
  - `GRAME_API_BASE`（任意）：既定 `https://api.groq.com/openai/v1`
  - `GRAME_MODEL`（任意）：既定 `qwen/qwen3.8-27b`
  設定後に再デプロイすると、画面が自動でAI対戦モードに切り替わる。
  ブラウザは同一オリジンの `/api/chat`（サーバーレス関数）だけを叩き、キーはサーバー内でのみ使われる。

## 技術

- `index.html`（UI＋文法エンジン＋CSV埋め込み）＋ `api/chat.js`（Vercel サーバーレス関数）
- 文法エンジンは `index.html` 内の `<script id="grame-engine">`：起動時に
  `<script type="text/plain" id="lexicon-csv">` のCSVを読み、状態遷移で
  主語→（時間・副詞・介詞句）→述語→目的語 の語順と、的・了・語気助詞・節の接続を判定する
- AI対戦モードの判定／手生成プロンプトは `JUDGE_SYSTEM` / `MOVE_SYSTEM`
