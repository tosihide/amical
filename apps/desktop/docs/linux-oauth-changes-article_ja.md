# ElectronアプリのLinux対応で遭遇したOAuth認証の罠 --- Chromiumのカスタムスキーム切り詰め問題と対策

## 導入

Electron製のデスクトップアプリをLinuxに移植する作業をしていた。macOSとWindowsでは問題なく動いていたOAuth認証が、Linuxでだけ動かない。調べてみると、Chromiumのカスタムスキーム処理に起因する、なかなか情報が出てこない問題に連鎖的に遭遇した。

この記事では、実際のコードを交えながら、遭遇した4つの問題とその解決策を共有する。同じような状況で困っている人の助けになれば幸いだ。

---

## 背景 --- macOS/Windowsとの違い

アプリ（Amical）はOAuth2 PKCE認証を使っている。macOSとWindowsでは、OSのdeep link機構を利用してコールバックを受け取る仕組みだ。

```
1. アプリが外部ブラウザでauthorize URLを開く
2. ユーザーがブラウザでログインする
3. サーバーが amical://oauth/callback?code=xxx にリダイレクト
4. OSがdeep linkを処理し、アプリにURLを渡す
5. アプリがcodeをtokenに交換する
```

macOSでは`app.on("open-url")`、Windowsではsingle instanceの`second-instance`イベントでURLを受け取れる。シンプルだ。

**しかしLinuxではこれが動かない。**

Linuxにもカスタムスキームのハンドラ登録機構（`.desktop`ファイルの`MimeType=x-scheme-handler/amical`）はあるが、外部ブラウザからアプリにURLが渡される挙動が不安定で、環境依存が大きい。特にAppImageやSandbox環境では信頼性が低い。

そこで、Linux向けにはBrowserWindowを使ってアプリ内でOAuthフロー全体を完結させる方式に変更した。ここから問題が始まる。

---

## 問題1: will-redirectとwill-navigateの使い分け

### OAuthフローの流れ

Linux向けの実装では、BrowserWindowでログインページを開き、認証完了後にauthorize endpointへ遷移させる。このとき、サーバー側の302リダイレクトをどうキャッチするかが最初の課題だった。

```
ユーザー操作                    イベント
─────────────────────────────────────────────
1. ログインページ表示            loadURL()
2. メール/パスワード入力          (ユーザー操作)
3. ログイン完了 → ルートへ遷移    did-navigate-in-page or did-navigate
4. authorize endpointへ遷移      loadURL()
5. サーバーが302でコールバックへ   will-redirect ← ここでキャッチ
```

### ログイン完了検知の罠

ステップ3の「ログイン完了」の検知が曲者だった。ログインページ（login.amical.ai/auth/sign-in）でログインが完了すると、ルートURL（login.amical.ai/）に遷移する。しかし、**この遷移がSPA内の画面遷移（`did-navigate-in-page`）になるか、フルナビゲーション（`did-navigate`）になるかは、サーバー側のセッション状態によって変わる。**

初回ログインでは`did-navigate-in-page`、短時間に再ログインすると`did-navigate`になる、といった具合だ。

結局、両方のイベントをリッスンすることで解決した:

```typescript
const onLoginComplete = (_event: unknown, url: string) => {
  if (
    !authorizeAttempted &&
    (url === "https://login.amical.ai/" ||
      url === "https://login.amical.ai")
  ) {
    authorizeAttempted = true;
    logger.main.info("Login complete, navigating to authorize endpoint");
    this.authWindow?.loadURL(authorizeUrl);
  }
};
this.authWindow.webContents.on("did-navigate-in-page", onLoginComplete);
this.authWindow.webContents.on("did-navigate", onLoginComplete);
```

`authorizeAttempted`フラグで二重実行を防いでいる。

### コールバックのキャッチ

authorize endpointからのリダイレクトは`will-redirect`でキャッチする。`will-navigate`ではなく`will-redirect`なのは、これがサーバーからの302レスポンスによるリダイレクトだからだ:

```typescript
this.authWindow.webContents.on("will-redirect", (event, url) => {
  if (url.startsWith(redirectUri)) {
    event.preventDefault();
    logger.main.info("OAuth callback captured via will-redirect:", url);
    this.handleDeepLinkFromWindow(url);
  }
});
```

HTTPSのコールバックURL（例: `https://core.amical.ai/auth/callback`）をredirectUriとして使う場合、`will-redirect`で完全なURLが取得でき、ここまでは問題なく動く。

---

## 問題2: Chromiumのカスタムスキーム URL切り詰め

ここからが本丸だ。

redirectUriとしてカスタムスキーム `amical://oauth/callback` を使った場合に問題が発生した。

### 症状

authorize endpointがカスタムスキームへ302リダイレクトを返す場合:

```
HTTP/1.1 302 Found
Location: amical://oauth/callback?code=AUTH_CODE&state=STATE
```

このURLを`will-navigate`で受け取ると、**`amical://`だけに切り詰められている。** パス（`/oauth/callback`）もクエリパラメータ（`?code=...&state=...`）もすべて消えている。

```typescript
// will-navigate で受け取るURL
"amical://"  // ← code も state もない！
```

`protocol.handle`でカスタムスキームを登録しても同様だった。

### 原因

Chromiumは非標準のスキーム（`http`/`https`/`file`等以外）のURLに対して、URL正規化（canonicalization）を適用する。この正規化の過程で、Chromiumが認識しないスキームのURLはスキーム部分のみに切り詰められる。

これはChromiumのセキュリティ機構の一部で、未知のスキームに対してURLの構造（authority, path, query）を保証しないという設計思想に基づいている。

### 解決策: registerSchemesAsPrivileged

`main.ts`の**最初のほう**（`app.ready`の前）で、カスタムスキームを「特権スキーム」として登録する:

```typescript
import { app, protocol } from "electron";

// app.ready より前に呼ぶ必要がある
protocol.registerSchemesAsPrivileged([
  { scheme: "amical", privileges: { standard: true, secure: true } },
]);
```

`standard: true`を指定することで、Chromiumはこのスキームを標準的なURL構造を持つスキームとして扱い、パスやクエリパラメータが保持されるようになる。`secure: true`は、このスキームをHTTPSと同等のセキュリティコンテキストで動作させる。

**重要: この呼び出しは`app.ready`イベントの前に行う必要がある。** Chromiumの初期化時にスキーム情報が確定するため、初期化後に登録しても効果がない。

実際のコードでは、importの直後に配置している:

```typescript
// main.ts 冒頭
import dotenv from "dotenv";
dotenv.config();

import { app, ipcMain, protocol } from "electron";
import { logger } from "./logger";

// Register amical:// as a standard scheme so Chromium preserves the full URL
// (path, query params) in navigation events and protocol handlers.
// Must be called before app.ready.
protocol.registerSchemesAsPrivileged([
  { scheme: "amical", privileges: { standard: true, secure: true } },
]);
```

---

## 問題3: カスタムスキームによるプロセス増殖

問題2を解決して`will-navigate`でフルURLが取れるようになった...が、別の問題が現れた。

### 症状

BrowserWindow内で`amical://oauth/callback?code=...`への遷移が発生すると、**OSがこのURLをシステムのプロトコルハンドラに渡そうとし、アプリの別プロセスが起動される。** single instanceロックがあるので2つ目のプロセスはすぐ終了するが、ログが汚れるし、タイミングによっては認証フローが中断される。

### 解決策: session.protocol.handleでインプロセス処理

BrowserWindowのセッションに対してプロトコルハンドラを登録し、カスタムスキームへの遷移をプロセス内で完結させる:

```typescript
// authWindow の session に対してハンドラを登録
this.authWindow.webContents.session.protocol.handle("amical", (request) => {
  const fullUrl = request.url;
  logger.main.info("OAuth callback captured via protocol handler:", fullUrl);
  this.handleDeepLinkFromWindow(fullUrl);
  return new Response("", { status: 200 });
});
```

`protocol.handle`（グローバル）ではなく`session.protocol.handle`（セッションスコープ）を使っている点がポイントだ。これにより:

- 認証用BrowserWindow内でのみハンドラが有効になる
- メインウィンドウやその他のWebContentsに影響しない
- OSのプロトコルハンドラに遷移が渡されない

---

## 問題4: サーバー側の挙動変化

テストを繰り返していると、「さっきは動いたのに今は動かない」という状況に遭遇した。

### 症状

短時間に連続してログイン・ログアウトを繰り返すと、authorize endpointの挙動が変わる:

- **初回ログイン**: authorize endpoint → 302 → HTTPS callback URL
- **短時間での再ログイン**: authorize endpoint → 302 → `amical://oauth/callback?code=...` （カスタムスキームに直接リダイレクト）

サーバー側がセッションの状態を見て、リダイレクト先を動的に変えているようだった。

### 対策

HTTPS callbackとカスタムスキームcallbackの**両方**を処理できるようにした。`will-redirect`でHTTPSコールバックをキャッチし、`session.protocol.handle`でカスタムスキームコールバックをキャッチする。どちらが来ても同じ`handleDeepLinkFromWindow`メソッドで処理する:

```typescript
// HTTPS callback: will-redirect でキャッチ
this.authWindow.webContents.on("will-redirect", (event, url) => {
  if (url.startsWith(redirectUri)) {
    event.preventDefault();
    this.handleDeepLinkFromWindow(url);
  }
});

// カスタムスキーム callback: session protocol handler でキャッチ
this.authWindow.webContents.session.protocol.handle("amical", (request) => {
  const fullUrl = request.url;
  this.handleDeepLinkFromWindow(fullUrl);
  return new Response("", { status: 200 });
});
```

コールバックURLのパース側も、両方のスキームに対応している:

```typescript
private handleDeepLinkFromWindow(url: string): void {
  const parsedUrl = new URL(url);
  const redirectUri = this.activeRedirectUri || this.config.redirectUri;

  // amical://oauth/callback と HTTPS redirect URI の両方にマッチ
  const isAmicalScheme =
    parsedUrl.host === "oauth" && parsedUrl.pathname === "/callback";
  const isHttpsRedirect = url.startsWith(redirectUri);

  if (isAmicalScheme || isHttpsRedirect) {
    const code = parsedUrl.searchParams.get("code");
    const state = parsedUrl.searchParams.get("state");
    if (code) {
      this.handleAuthCallback(code, state);
    }
  }
}
```

---

## 最終的な実装

全体の構造をまとめると以下のようになる。

### main.ts（起動時）

```typescript
import { app, protocol } from "electron";

// Chromiumの初期化前にカスタムスキームを登録（必須）
protocol.registerSchemesAsPrivileged([
  { scheme: "amical", privileges: { standard: true, secure: true } },
]);

// ... app.ready 後 ...

// macOS/Windows向け: OSのdeep linkハンドラ登録
app.setAsDefaultProtocolClient("amical");

// macOS: open-url イベントでコールバック受信
app.on("open-url", (event, url) => {
  event.preventDefault();
  appManager.handleDeepLink(url);
});
```

### auth-service.ts（Linux向けOAuthフロー）

```typescript
async login(): Promise<void> {
  // PKCE パラメータ生成
  const { verifier, challenge } = this.generatePKCE();
  const state = this.generateState();
  this.pendingAuth = { state, codeVerifier: verifier, codeChallenge: challenge };

  if (process.platform === "linux") {
    // Linux: BrowserWindowでフロー全体を実行
    this.openAuthWindow(loginUrl, authorizeUrl);
  } else {
    // macOS/Windows: 外部ブラウザ → deep link
    await shell.openExternal(authorizeUrl);
  }
}
```

Linux分岐の`openAuthWindow`が、ここまで述べた4つの問題への対策をすべて含んでいる。

### プラットフォーム判定の設計方針

`process.platform === "linux"`での分岐は`login()`メソッドの1箇所のみ。コールバック処理（`handleDeepLinkFromWindow`）やトークン交換（`exchangeCodeForToken`）はプラットフォーム共通のコードだ。分岐を最小限に抑えることで、保守性を確保している。

---

## E2Eテストの自動化

OAuth認証フローは手動テストが面倒だ。ブラウザ操作、リダイレクト、トークン交換と、ステップが多い。

このプロジェクトでは、Claude Code + electron-test-mcp（Electron用MCPツール）を使ってE2Eテストの自動化を試みた。MCPツールを使うと、Claude Codeからelectronアプリの操作（クリック、テキスト入力、スクリーンショット取得など）をプログラマティックに実行できる。

テストの流れ:

1. `mcp__electron-test__launch` でアプリを起動
2. `mcp__electron-test__click` でログインボタンをクリック
3. 認証ウィンドウでメール/パスワードを入力
4. `mcp__electron-test__screenshot` で画面を確認
5. リダイレクト後の状態を検証

ただし、`will-redirect`の2回目が発火しないケースがあるなど、イベントの検知に課題が残っている。Electronのナビゲーションイベントの挙動はWebContentsの状態に依存する部分が多く、テストの安定化には追加の調査が必要だ。

---

## まとめ

Electron製アプリのLinux対応でOAuth認証を実装する際に遭遇した問題と対策をまとめる:

| 問題 | 原因 | 対策 |
|------|------|------|
| ログイン完了検知 | SPAナビゲーション or フルナビゲーションがサーバー状態で変わる | `did-navigate-in-page` と `did-navigate` の両方をリッスン |
| URL切り詰め | Chromiumの非標準スキームURL正規化 | `protocol.registerSchemesAsPrivileged` で standard: true を指定 |
| プロセス増殖 | カスタムスキーム遷移がOSのハンドラに渡される | `session.protocol.handle` でインプロセス処理 |
| リダイレクト先の変化 | サーバー側のセッション状態依存 | HTTPS と カスタムスキーム の両方に対応 |

### 学んだこと

1. **`registerSchemesAsPrivileged`は`app.ready`の前に呼ぶ。** これを知らないと、カスタムスキームのURLが切り詰められる問題に永遠にハマる。Electronの公式ドキュメントにも記載はあるが、OAuthの文脈での具体例は少ない。

2. **Electronのナビゲーションイベントは多い。** `will-navigate`, `did-navigate`, `will-redirect`, `did-redirect`, `did-navigate-in-page`... 用途に応じて正しいイベントを選ぶ必要がある。特にサーバーサイドの302リダイレクトは`will-redirect`であり、`will-navigate`ではない。

3. **サーバー側の挙動も変わりうる。** クライアント側だけ見ていると原因がわからない問題がある。同じauthorize endpointでも、セッション状態によってリダイレクト先が変わることがある。

4. **プラットフォーム分岐は最小限に。** 分岐が多いとテストのコストが跳ね上がる。Linux向けの分岐は`login()`内の1箇所に集約し、下流の処理は共通化した。

Electron + LinuxでOAuth認証を実装しようとしている方の参考になれば幸いだ。
