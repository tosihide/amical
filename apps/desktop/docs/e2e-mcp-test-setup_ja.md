# Electron E2E テスト with electron-test-mcp (Linux)

## 概要

### electron-test-mcp とは

`electron-test-mcp` は、Playwright の Electron サポートをラップした MCP (Model Context Protocol) サーバーです。Claude Code が MCP クライアントとして接続し、Electron アプリの起動・操作・スクリーンショット取得・DOM 操作・メインプロセスでの JS 実行などをツール呼び出しで行えます。

通常の E2E テストフレームワーク（Cypress、Playwright 単体など）ではテストコードをスクリプトとして事前に書く必要がありますが、electron-test-mcp を使うと Claude Code との対話の中でリアルタイムにアプリを操作・検証できます。これにより、OAuth フローのような複雑な画面遷移のデバッグが対話的に行えます。

### 動作原理

```
Claude Code (MCP Client)
    ↓ MCP tool call (JSON-RPC)
electron-test-mcp (MCP Server)
    ↓ Playwright Electron API
Electron App (Amical Desktop)
```

Claude Code から `mcp__electron-test__launch()` などのツールを呼ぶと、electron-test-mcp が Playwright 経由で Electron アプリを起動・制御します。

### 主要な MCP ツール一覧

| ツール | 用途 | 備考 |
|--------|------|------|
| `launch` | アプリ起動 | `appPath`, `env`, `executablePath` を指定 |
| `close` | アプリ終了 | |
| `screenshot` | スクリーンショット取得 | Base64 画像が返る |
| `snapshot` | アクセシビリティツリー取得 | 画面構造の把握に有用 |
| `click` | 要素クリック | Playwright セレクタ指定 |
| `fill` | テキスト入力 | |
| `press` | キー入力 | |
| `hover` | ホバー | |
| `evaluate` | レンダラープロセスで JS 実行 | フォーカスされたウィンドウが対象 |
| `evaluateMain` | メインプロセスで JS 実行 | `(electron) => ...` 形式 |
| `getText` | テキスト取得 | |
| `getAttribute` | 属性取得 | |
| `isVisible` | 表示状態確認 | |
| `wait` | 待機 | セレクタの出現待ちなど |
| `count` | 要素数取得 | |
| `selectOption` | セレクトボックス操作 | |
| `drag` | ドラッグ操作 | |
| `type` | キーボード入力（1文字ずつ） | |
| `connect` | 既存アプリに接続 | |
| `disconnect` | 接続解除 | |

---

## インストール

### 1. Claude Code MCP 設定

`~/.claude/settings.json` の `mcpServers` に以下を追加:

```json
{
  "mcpServers": {
    "electron-test": {
      "command": "npx",
      "args": ["electron-test-mcp"]
    }
  }
}
```

初回実行時に `~/.npm/_npx/` 配下に自動インストールされます。

### 2. Linux 環境でのパッチ（必須）

#### パッチが必要な理由

`electron-test-mcp` v0.1.0 はデフォルトで macOS 向けに設計されており、Linux (Ubuntu) 環境では以下の問題で動作しません:

1. **`executablePath` 未指定** — `electron` コマンドが PATH に無い環境では起動失敗
2. **`--no-sandbox` 未指定** — root 以外のユーザーで Chromium sandbox エラー
3. **`--ozone-platform=x11` 未指定** — Wayland/X11 環境で表示問題が発生する場合がある
4. **`ELECTRON_DISABLE_SANDBOX` 未設定** — sandbox 関連のクラッシュ

#### パッチ対象ファイルの特定

```bash
find ~/.npm/_npx -path "*/electron-test-mcp/dist/index.js" | head -1
```

出力例: `~/.npm/_npx/abc123def/node_modules/electron-test-mcp/dist/index.js`

#### パッチ内容

`launch` ケースの Electron 起動部分（`_electron.launch` 呼び出し）を変更します。

**変更前:**
```javascript
const appPath = args?.appPath || "./out/main/index.js";
const env = args?.env || {};
electronApp = await _electron.launch({
    args: [appPath],
    env: { ...process.env, ...env, TEST_MODE: "true" },
});
```

**変更後:**
```javascript
const appPath = args?.appPath || "./out/main/index.js";
const env = args?.env || {};
const execPath = args?.executablePath || process.env.ELECTRON_PATH || "/_O/amical/node_modules/electron/dist/electron";
electronApp = await _electron.launch({
    executablePath: execPath,
    args: ["--no-sandbox", "--ozone-platform=x11", appPath],
    env: { ...process.env, ...env, TEST_MODE: "true", ELECTRON_DISABLE_SANDBOX: "1" },
});
```

`/_O/amical` は実際のプロジェクトルートパスに置換してください。

#### パッチ適用スクリプト

```bash
# パッチファイルの場所を特定
MCP_INDEX=$(find ~/.npm/_npx -path "*/electron-test-mcp/dist/index.js" | head -1)
echo "Patching: $MCP_INDEX"

# バックアップ
cp "$MCP_INDEX" "$MCP_INDEX.bak"

# sed で置換（プロジェクトパスは適宜変更）
sed -i 's|electronApp = await _electron.launch({|const execPath = args?.executablePath || process.env.ELECTRON_PATH || "/_O/amical/node_modules/electron/dist/electron";\n                electronApp = await _electron.launch({\n                    executablePath: execPath,|' "$MCP_INDEX"
sed -i 's|args: \[appPath\],|args: ["--no-sandbox", "--ozone-platform=x11", appPath],|' "$MCP_INDEX"
sed -i 's|TEST_MODE: "true"|TEST_MODE: "true", ELECTRON_DISABLE_SANDBOX: "1"|' "$MCP_INDEX"
```

パッチ適用後、Claude Code を再起動（`/quit` → 再起動）して MCP サーバーを再読み込みしてください。

> **注意**: `npm cache clean` やキャッシュクリアでパッチが消えます。パッケージ更新でも上書きされます。

---

## 前提条件

### 1. アプリのフルビルド

MCP の `launch` モードでは Vite dev サーバーが起動しないため、事前にフルビルドが必要です。`pnpm start`（dev mode）は使えません。

```bash
cd /_O/amical/apps/desktop
pnpm package
```

これにより以下が生成されます:
- `.vite/build/main.js` — メインプロセスのエントリポイント
- `.vite/renderer/` — レンダラー側の HTML/JS/CSS

### 2. DB マイグレーション用シンボリックリンク

ビルド済み `main.js` は `process.cwd()` からの相対パスでマイグレーションフォルダを探します。プロジェクトルートから実行する場合:

```bash
ln -s /_O/amical/apps/desktop/src /_O/amical/src
```

このシンボリックリンクがないと、起動時に DB マイグレーションエラーで落ちます。

### 3. 環境変数ファイル (.env)

`/_O/amical/apps/desktop/.env` に以下を設定:

```env
TEST_EMAIL=your-test-email@example.com
TEST_PASSWORD=your-test-password
```

OAuth E2E テストで使用します。このファイルは `src/main/main.ts` の先頭で `dotenv.config()` により読み込まれます。

---

## テスト手順（詳細）

### Step 0: テスト環境のクリーンアップ（事前準備）

各テストランの前に、前回のデータを削除してフレッシュ状態にします:

```bash
# DB ファイルの削除（全候補パスを網羅）
rm -f ~/.config/Electron/amical.db \
      ~/.config/Amical/amical.db \
      /_O/amical/apps/desktop/amical.db \
      /_O/amical/amical.db

# auth セッションのクリア（必要に応じて）
rm -rf ~/.config/Electron/Partitions/auth-oauth
```

> **重要**: dev ビルド（`pnpm start` や MCP 経由）は `~/.config/Electron/` にデータを保存しますが、パッケージビルドは `~/.config/Amical/` を使います。詳細は後述の「注意事項」セクションを参照。

### Step 1: アプリ起動

```
mcp__electron-test__launch(
  appPath: "/_O/amical/apps/desktop/.vite/build/main.js",
  env: {"ELECTRON_DISABLE_SANDBOX": "1"}
)
```

成功すると Amical のオンボーディング画面（Step 1: Feature Selection）が表示されます。

起動後、`screenshot` または `snapshot` で画面状態を確認:

```
mcp__electron-test__screenshot()
mcp__electron-test__snapshot()
```

### Step 2: オンボーディング — Step 1 (Feature Selection)

「Contextual Dictation」カードをクリック:

```
mcp__electron-test__click(
  selector: "text=Contextual Dictation"
)
```

「Continue」ボタンをクリックして次へ:

```
mcp__electron-test__click(
  selector: "text=Continue"
)
```

### Step 3: オンボーディング — Step 2 (Permissions)

権限設定画面。「Continue」をクリック:

```
mcp__electron-test__click(
  selector: "text=Continue"
)
```

### Step 4: オンボーディング — Step 3 (Discovery)

連携先を選択（例: GitHub）してから Continue:

```
mcp__electron-test__click(
  selector: "text=GitHub"
)
mcp__electron-test__click(
  selector: "text=Continue"
)
```

### Step 5: オンボーディング — Step 4 (Model Selection)

ここで「Amical Cloud」カードを選択して OAuth サインインに進みます。

**重要**: Amical Cloud カードは通常の Playwright セレクタではクリックできません。React の内部イベントハンドラを直接呼び出す必要があります。

```
mcp__electron-test__evaluate(
  script: "(() => { const allEls = document.querySelectorAll('*'); for (const el of allEls) { const pk = Object.keys(el).find(k => k.startsWith('__reactProps')); if (pk && typeof el[pk]?.onClick === 'function' && el.textContent?.includes('Amical Cloud')) { el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true})); break; } } })()"
)
```

> **なぜ React onClick ワークアラウンドが必要か**: Amical Cloud カードのクリックイベントは React の合成イベント（SyntheticEvent）で管理されています。Playwright の `click` はネイティブ DOM イベントを発火しますが、React 18 ではイベントが `document` レベルでデリゲートされており、Playwright のクリックが React のハンドラに到達しないケースがあります。`__reactProps` から直接 `onClick` を呼ぶことで確実に動作します。

500ms 待ってからモーダルの「Sign in」ボタンをクリック:

```
mcp__electron-test__wait(
  timeout: 500
)
mcp__electron-test__evaluate(
  script: "(() => { const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Sign in'); if (btn) btn.click(); return btn ? 'clicked' : 'not found'; })()"
)
```

### Step 6: OAuth サインイン（auth ウィンドウ操作）

「Sign in」クリック後、Linux では `BrowserWindow` で `login.amical.ai` が開きます（macOS/Windows ではデフォルトブラウザが開く）。

#### 6a. auth ウィンドウの出現確認

```
mcp__electron-test__evaluateMain(
  script: "(electron) => electron.BrowserWindow.getAllWindows().map(w => ({id: w.id, title: w.getTitle(), url: w.webContents.getURL()}))"
)
```

期待される結果: ウィンドウが 2 つ（メインウィンドウ + auth ウィンドウ）。auth ウィンドウの URL は `https://login.amical.ai/auth/sign-in?...` のようになります。

#### 6b. ログインフォームの入力と送信

auth ウィンドウ内で `nativeSetter` を使ってフォームに値を設定し、送信します。React 管理のフォームでは `input.value = '...'` だけでは state が更新されないため、`HTMLInputElement.prototype.value` の setter を直接呼び、`input` イベントを発火させます。

```
mcp__electron-test__evaluateMain(
  script: "(electron) => { const authWin = electron.BrowserWindow.getAllWindows().find(w => w.getTitle().includes('Login') || w.webContents.getURL().includes('login.amical.ai')); if (!authWin) return 'auth window not found'; return authWin.webContents.executeJavaScript(`const emailInput = document.querySelector('input[type=\"email\"]'); const passInput = document.querySelector('input[type=\"password\"]'); const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; nativeSetter.call(emailInput, '${process.env.TEST_EMAIL}'); emailInput.dispatchEvent(new Event('input', {bubbles: true})); nativeSetter.call(passInput, '${process.env.TEST_PASSWORD}'); passInput.dispatchEvent(new Event('input', {bubbles: true})); setTimeout(() => document.querySelector('button[type=\"submit\"]').click(), 300); 'submitted'`); }"
)
```

> **注意**: `process.env.TEST_EMAIL` と `process.env.TEST_PASSWORD` はメインプロセスの環境変数から取得されます。`.env` ファイルに設定しておく必要があります。

#### 6c. OAuth コールバックの処理

ログイン成功後の流れ（auth-service.ts の実装に基づく）:

1. ユーザーがフォーム送信 → `login.amical.ai` がログイン処理
2. ログイン成功 → ページが `https://login.amical.ai/` （ルート）にナビゲーション
3. `did-navigate` または `did-navigate-in-page` イベントで検知
4. `authorizeUrl`（OAuth 認可エンドポイント）に自動遷移
5. サーバーが `302` リダイレクトで `redirectUri` にコールバック
6. `will-redirect` イベントでコールバック URL をキャプチャ
7. `code` と `state` パラメータを抽出してトークン交換
8. 認証成功 → auth ウィンドウが閉じる → `authenticated` イベント発火

### Step 7: 結果の確認

5秒待ってから確認:

```
mcp__electron-test__wait(
  timeout: 5000
)
```

#### 7a. ウィンドウ状態の確認

```
mcp__electron-test__evaluateMain(
  script: "(electron) => electron.BrowserWindow.getAllWindows().map(w => ({id: w.id, title: w.getTitle(), url: w.webContents.getURL()}))"
)
```

- **成功**: auth ウィンドウが消え、メインウィンドウのみ。Setup 画面が Step 5 "Setup Complete!" になっている
- **失敗**: auth ウィンドウが `https://login.amical.ai/` で止まっている → `did-navigate`/`did-navigate-in-page` が発火していない可能性

#### 7b. スクリーンショットで目視確認

```
mcp__electron-test__screenshot()
```

#### 7c. ログの確認（別ターミナルまたは Bash ツール）

```bash
grep -E "auth-diag|OAuth|Login complete|will-redirect|did-navigate" \
  ~/.config/Electron/logs/amical-dev.log | tail -30
```

期待されるログシーケンス:
```
[auth-diag] did-navigate: https://login.amical.ai/auth/sign-in?...
[auth-diag] did-navigate-in-page: https://login.amical.ai/
Login complete, navigating to authorize endpoint
[auth-diag] will-redirect: https://login.amical.ai/oauth2/callback/amical-desktop?code=...&state=...
OAuth callback captured via will-redirect: https://login.amical.ai/oauth2/callback/amical-desktop?code=...
Handling auth callback
Token exchange successful
Authentication successful
```

#### 7d. プロセスの確認

```bash
ps aux | grep -i electron | grep -v grep
```

### Step 8: クリーンアップ

```
mcp__electron-test__close()
```

その後、次のテストに備えて DB を削除:

```bash
rm -f ~/.config/Electron/amical.db \
      ~/.config/Amical/amical.db \
      /_O/amical/apps/desktop/amical.db \
      /_O/amical/amical.db
```

設定ディレクトリ全体のクリア（完全リセットしたい場合）:

```bash
# dev ビルド用
rm -rf ~/.config/Electron/

# パッケージビルド用
rm -rf ~/.config/Amical/
```

---

## 注意事項

### ~/.config/Electron vs ~/.config/Amical

Electron アプリの `app.getPath("userData")` は、アプリ名（`package.json` の `name` フィールドまたは `app.setName()` の値）に基づいて決定されます。

| ビルド形態 | データ保存先 | 該当ケース |
|-----------|-------------|-----------|
| dev ビルド (`pnpm start`, MCP `launch`) | `~/.config/Electron/` | `app.isPackaged === false` |
| パッケージビルド (`pnpm make` で生成した .deb/.rpm) | `~/.config/Amical/` | `app.isPackaged === true` |

**MCP テストでは `~/.config/Electron/` が使われます。** DB 削除やログ確認の際は注意してください。ただし両方のパスを念のため削除しておくと安全です。

### 5分間隔ルール（繰り返しテスト時）

サーバー側の認可挙動は、前回のログインからの経過時間によって異なります:

- **短時間（5分以内）での再テスト**: サーバーがセッションを記憶しており、ログイン画面をスキップして直接認可する場合がある。この場合、`did-navigate-in-page` ではなく `did-navigate` が発火する、あるいはまったく異なるフローになることがある
- **5分以上経過後**: セッションが切れ、フルログインフローが走る

連続テストで異なる結果が出る場合は、**最低5分間隔を空けて**再テストしてください。

また、auth セッションパーティションを削除すると強制的にフルログインフローになります:

```bash
rm -rf ~/.config/Electron/Partitions/auth-oauth
```

### amical:// プロトコルとプロセス生成問題

`main.ts` の先頭で `protocol.registerSchemesAsPrivileged()` を呼んでいます:

```typescript
protocol.registerSchemesAsPrivileged([
  { scheme: "amical", privileges: { standard: true, secure: true } },
]);
```

この登録がないと、`amical://oauth/callback` への 302 リダイレクト時に以下の問題が発生します:

1. Chromium が `amical://` スキームを「外部プロトコル」として扱い、OS のプロトコルハンドラに委譲
2. OS が新しい Electron プロセスを起動しようとする（`app.setAsDefaultProtocolClient` で登録済みのため）
3. 新プロセスが起動するが、元のプロセスとは別なのでコールバックが届かない

`registerSchemesAsPrivileged` により `amical://` が「標準的なスキーム」として登録され、Chromium 内部でパスやクエリパラメータが保持されます。ただし Linux では現在 `will-redirect` + HTTPS リダイレクト URI 方式を使っているため、`amical://` の問題は回避されています。

### React onClick ワークアラウンド

Amical Cloud カードのクリックに関して、通常の Playwright `click` が効かない問題があります。これは React 18 のイベントデリゲーション（`document` ルートにリスナーが登録される）に起因します。

ワークアラウンド: `__reactProps$xxx` プロパティから `onClick` を取得して `MouseEvent` を手動ディスパッチ:

```javascript
const allEls = document.querySelectorAll('*');
for (const el of allEls) {
  const pk = Object.keys(el).find(k => k.startsWith('__reactProps'));
  if (pk && typeof el[pk]?.onClick === 'function'
      && el.textContent?.includes('Amical Cloud')) {
    el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
    break;
  }
}
```

このワークアラウンドは `__reactProps` というReact 内部実装に依存しているため、React のバージョンアップで動作しなくなる可能性があります。

---

## トラブルシューティング

### アプリが起動しない

| 症状 | 原因 | 対処 |
|------|------|------|
| `Cannot find module` | ビルドされていない | `pnpm package` を実行 |
| `Running as root without --no-sandbox is not supported` | sandbox エラー | パッチで `--no-sandbox` と `ELECTRON_DISABLE_SANDBOX=1` を追加 |
| `electron: command not found` | executablePath 未設定 | パッチで `executablePath` を追加 |
| DB migration エラー | symlink がない | `ln -s /_O/amical/apps/desktop/src /_O/amical/src` |
| 画面が真っ黒 | レンダラーのビルドがない | `pnpm package` で `.vite/renderer/` が生成されているか確認 |

### OAuth ログインが失敗する

| 症状 | 原因 | 対処 |
|------|------|------|
| auth ウィンドウが開かない | `login()` が呼ばれていない | スクリーンショットで Step 4 の状態を確認 |
| auth ウィンドウが `login.amical.ai` で止まる | `did-navigate`/`did-navigate-in-page` 未発火 | ログを確認。5分ルールに該当しないか確認 |
| `will-redirect` が発火しない | リダイレクト URI の不一致 | `.env` の `AUTH_REDIRECT_URI` を確認 |
| `Token exchange failed` | PKCE 検証失敗 or 期限切れ | 5分以上待ってから再テスト |
| `State mismatch` | state パラメータの不一致 | DB 削除して完全にやり直し |
| `input[type="email"]` が見つからない | ページ読み込み未完了 | `wait` で 2-3 秒待ってからフォーム入力 |
| `process.env.TEST_EMAIL` が undefined | `.env` 未設定 | `apps/desktop/.env` にテスト資格情報を設定 |

### MCP 接続の問題

| 症状 | 原因 | 対処 |
|------|------|------|
| `MCP tool not found` | MCP サーバー未接続 | Claude Code を再起動。`/mcp` で接続状態を確認 |
| `electronApp is not defined` | `launch` 前に他のツールを呼んだ | 先に `launch` を実行 |
| パッチが効いていない | npm キャッシュクリア or パッケージ更新 | `find ~/.npm/_npx -path "*/electron-test-mcp/dist/index.js"` で再確認してパッチ再適用 |

### 2回目のテストで挙動が変わる

原因: サーバー側セッションの残存。対処法:

1. auth セッションパーティション削除: `rm -rf ~/.config/Electron/Partitions/auth-oauth`
2. 5分以上間隔を空ける
3. DB 削除して `pendingAuth` 状態をリセット

---

## ログファイルの場所と確認方法

### ログファイルパス

| ビルド | パス |
|--------|------|
| dev ビルド（MCP テスト） | `~/.config/Electron/logs/amical-dev.log` |
| パッケージビルド | `~/.config/Amical/logs/amical.log` |

ログフォーマット: `[日時] [level] [scope] メッセージ`

### 有用な grep パターン

```bash
# OAuth フロー全体の追跡
grep -E "OAuth|auth-diag|Login complete|will-redirect|did-navigate|handleAuthCallback|Token exchange|Authentication" \
  ~/.config/Electron/logs/amical-dev.log | tail -40

# エラーのみ
grep -i "error" ~/.config/Electron/logs/amical-dev.log | tail -20

# AuthService の初期化と設定確認
grep "AuthService initialized" ~/.config/Electron/logs/amical-dev.log

# リダイレクト URI の確認
grep "redirectUri\|redirect_uri\|OAuth callback" ~/.config/Electron/logs/amical-dev.log

# DB マイグレーション
grep -i "migration" ~/.config/Electron/logs/amical-dev.log

# メインプロセスのエラー
grep "\[main\].*error" ~/.config/Electron/logs/amical-dev.log | tail -10
```

### ログの最大サイズ

ログファイルは最大 10MB でローテーションされます（`electron-log` の設定）。テストを繰り返す場合、古いログが消えることがあります。重要なログはテスト直後に確認してください。

### リアルタイムログ監視

テスト中にリアルタイムでログを監視する場合:

```bash
tail -f ~/.config/Electron/logs/amical-dev.log | grep --line-buffered -E "OAuth|auth-diag|Login|error"
```
