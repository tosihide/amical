# Electron製デスクトップアプリのLinux移植記 — クリップボード、キー入力、通知音で遭遇した問題と対策

## 導入

macOS/Windows向けに開発されたElectronデスクトップアプリ（音声ディクテーションツール）をLinuxへ移植した際に遭遇した問題と、その解決策をまとめます。OAuthの話題は別記事に譲り、本記事ではそれ以外の問題群、具体的には**クリップボード操作**、**キー入力監視**、**通知音再生**、**ウィンドウ管理**、**ヘルパープロセス**、**初期化順序**に焦点を当てます。

対象環境はUbuntu 24.04 LTS / GNOME / Wayland です。

---

## 1. ペースト（クリップボード）問題

### 問題

音声認識の結果をアクティブなアプリケーションにペーストする機能が、Linuxで動作しませんでした。macOS/Windowsではネイティブヘルパーにクリップボードの読み書きとキーストロークのシミュレーションの両方を委任していますが、Linux上では`wl-copy`が非同期で動作するため、**クリップボードへの書き込みが完了する前にペーストキーストロークが発火される**というレースコンディションが発生しました。

### 解決策：Electron clipboard API + ヘルパーの役割分担

Electron本体のプロセスで同期的にクリップボードに書き込み、ヘルパーにはキーストロークの送信のみを依頼する方式にしました。

```typescript
// recording-manager.ts
import { clipboard } from "electron";

if (isLinux()) {
  // Linux: use Electron clipboard API (synchronous, reliable) then
  // ask the helper only for the keystroke simulation.
  // This avoids the wl-copy async race condition.
  const savedClipboard = preserveClipboard
    ? clipboard.readText()
    : null;
  clipboard.writeText(transcription);

  void nativeBridge
    .call("pasteText", {
      transcript: transcription,
      preserveClipboard: false, // clipboard already set by Electron
      keystrokeOnly: true,
    })
    .then(() => {
      if (savedClipboard !== null) {
        setTimeout(() => {
          clipboard.writeText(savedClipboard);
        }, 500);
      }
    });
} else {
  // macOS/Windows: delegate everything to native helper
  void nativeBridge.call("pasteText", {
    transcript: transcription,
    preserveClipboard,
  });
}
```

ポイントは`keystrokeOnly: true`フラグです。ヘルパー側ではこのフラグを見て、クリップボード操作をスキップしキーストロークだけ送信します。

### キーストロークの選択：Shift+Insert

もう一つの問題は、**どのキーストロークでペーストをシミュレートするか**です。

- `Ctrl+V` --- ターミナルアプリでは動作しない（ターミナルでは`Ctrl+Shift+V`が慣例）
- `Ctrl+Shift+V` --- VS Codeではプレーンテキストペーストではなくマークダウンプレビューが開いてしまう

最終的に `Shift+Insert` を採用しました。これはGUIアプリとターミナルの両方で動作します。

```typescript
// paste-text.ts (LinuxHelper側)
async function simulatePaste(): Promise<void> {
  try {
    // Try v0.1.x format first (more common on Ubuntu 24.04)
    await run("ydotool", ["key", "shift+Insert"]);
  } catch {
    // Fallback: try v1.x format (keycode 42=SHIFT, 110=INSERT)
    await run("ydotool", ["key", "42:1", "110:1", "110:0", "42:0"]);
  }
}
```

`ydotool`はバージョンによってAPIが異なるため（v0.1.xはキー名形式、v1.x以降はキーコード形式）、両方にフォールバックしています。

---

## 2. キー入力・ホットキー — evdevによるグローバルキー監視

### 問題

macOSでは`CGEvent`タップ、WindowsではLow-Level Keyboard Hookでグローバルにキー入力を監視できます。LinuxにはElectron標準でそのような仕組みがなく、`globalShortcut` APIでは修飾キーの組み合わせしか登録できないため、Push-to-Talk（キーを押している間だけ録音）のようなユースケースに対応できません。

### 解決策：evdevデバイスの直接読み取り

`/dev/input/eventN` デバイスを直接開いて `input_event` 構造体をパースする方式を採用しました。

```typescript
// evdev/monitor.ts
// struct input_event on 64-bit:
// { uint64 sec, uint64 usec, uint16 type, uint16 code, int32 value }
const INPUT_EVENT_SIZE = 24;
const EV_KEY = 1;

function parseInputEvent(
  buf: Buffer,
  offset: number,
): { type: number; code: number; value: number } | null {
  if (buf.length - offset < INPUT_EVENT_SIZE) return null;
  const type = buf.readUInt16LE(offset + 16);
  const code = buf.readUInt16LE(offset + 18);
  const value = buf.readInt32LE(offset + 20);
  return { type, code, value };
}
```

キーボードデバイスの特定には `/sys/class/input/eventN/device/capabilities/key` を読み取り、ビットが20以上立っているデバイスを「キーボード」と判定しています。マウスやゲームパッドなどのデバイスを誤って監視しないための工夫です。

```typescript
// evdev/monitor.ts
function scanKeyboardDevices(): string[] {
  const devices: string[] = [];
  const entries = fs.readdirSync("/dev/input");
  for (const entry of entries) {
    if (!entry.startsWith("event")) continue;
    const capsPath = `/sys/class/input/${entry}/device/capabilities/key`;
    const caps = fs.readFileSync(capsPath, "utf-8").trim();
    const parts = caps.split(" ");
    const totalBits = parts.reduce((sum, hex) => {
      let count = 0;
      let n = BigInt(`0x${hex}`);
      while (n) {
        count += Number(n & 1n);
        n >>= 1n;
      }
      return sum + count;
    }, 0);
    // Real keyboards have many key capabilities (>20 bits set)
    if (totalBits > 20) {
      devices.push(`/dev/input/${entry}`);
    }
  }
  return devices;
}
```

> **前提条件**: ユーザーが `input` グループに所属している必要があります (`sudo usermod -aG input $USER`)。

### evdevキーコードのマッピング

macOSとWindowsではそれぞれ独自のキーコード体系を使いますが、Linuxではevdevキーコードが標準です。3プラットフォーム分のマッピングテーブルを用意し、実行時にプラットフォームを判定して切り替えます。

```typescript
// keycode-map.ts
const linuxEvdevToKey: Record<number, string> = {
  // Modifier keys
  29: "Ctrl",
  97: "RCtrl",
  42: "Shift",
  54: "RShift",
  56: "Alt",
  100: "RAlt",
  125: "Cmd", // Super/Meta left (mapped to Cmd for consistency)
  126: "RCmd",
  464: "Fn",
  // Letters (evdev codes 16-50 follow QWERTY layout)
  16: "Q", 17: "W", 18: "E", /* ... */
  // ...全130以上のキーに対応
};

export function getKeyFromKeycode(keycode: number): string | undefined {
  const mapping = isLinux()
    ? linuxEvdevToKey
    : isWindows()
      ? windowsVKToKey
      : macOSKeycodeToKey;
  return mapping[keycode];
}
```

### デフォルトショートカット

macOSの `Fn` キーのようにLinuxで「他のアプリと干渉しにくいキー」を探した結果、Push-to-Talkには `Ctrl+Super` を採用しました。

```typescript
// app-settings.ts
if (isLinux()) {
  return {
    pushToTalk: [LINUX_KEYCODES.CTRL, LINUX_KEYCODES.META],
    toggleRecording: [
      LINUX_KEYCODES.CTRL,
      LINUX_KEYCODES.META,
      LINUX_KEYCODES.SPACE,
    ],
    pasteLastTranscript: [
      LINUX_KEYCODES.ALT,
      LINUX_KEYCODES.SHIFT,
      LINUX_KEYCODES.V,
    ],
    newNote: [LINUX_KEYCODES.ALT, LINUX_KEYCODES.SHIFT, LINUX_KEYCODES.N],
  };
}
```

---

## 3. 通知音 — Linuxでの音声再生

### 問題

macOSでは`NSSound`、Windowsでは`PlaySound` APIで手軽に効果音を鳴らせますが、Linuxには統一的な音声再生APIがありません。

### 解決策：GStreamerをデタッチで起動

`gst-play-1.0`（GStreamerのコマンドラインプレーヤー）をdetachedプロセスとして起動する方式を採用しました。RPC応答をブロックしないようにするためです。

```typescript
// handlers/recording.ts (LinuxHelper)
function playSound(soundName: string): void {
  const soundFile = path.join(getResourcesDir(), `${soundName}.mp3`);
  if (!fs.existsSync(soundFile)) {
    process.stderr.write(`Sound file not found: ${soundFile}\n`);
    return;
  }

  const child = spawn("gst-play-1.0", [soundFile], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  child.on("error", () => {
    process.stderr.write(`gst-play-1.0 not available, sound skipped\n`);
  });
}
```

録音開始・停止時にシステムのオーディオをミュートする機能（自分の声がスピーカーから出力されるのを防ぐ）には `pactl`（PulseAudio/PipeWireのCLIツール）を使っています。

```typescript
// 録音開始時にシステム音声をミュート
await execFileAsync("pactl", ["set-sink-mute", "@DEFAULT_SINK@", "1"]);

// 録音終了時に元に戻す
await execFileAsync("pactl", ["set-sink-mute", "@DEFAULT_SINK@", "0"]);
```

---

## 4. ウィンドウ管理 — Linux固有のウィンドウ設定

### 問題

macOSでは`titleBarStyle: "hiddenInset"` + vibrancyでネイティブ感のあるウィンドウが作れます。Windowsでは`titleBarStyle: "hidden"` + `titleBarOverlay`でカスタムタイトルバーが実現できます。しかし、Linuxではどちらの方式も期待通りに動作せず、描画が崩れることがありました。

### 解決策：Linuxではデフォルトのフレームを使用

Linuxでは無理にカスタマイズせず、OSのデフォルトウィンドウフレームをそのまま使う方針にしました。

```typescript
// window-manager.ts
this.mainWindow = new BrowserWindow({
  frame: true,
  backgroundColor:
    process.platform === "darwin" ? "#00000000" : colors.backgroundColor,
  ...(process.platform === "darwin"
    ? {
        titleBarStyle: "hiddenInset",
        vibrancy: "menu",
      }
    : process.platform === "linux"
      ? {} // Linux: use default OS frame, no custom title bar
      : {
          titleBarStyle: "hidden",
          titleBarOverlay: {
            color: colors.backgroundColor,
            symbolColor: colors.symbolColor,
            height: 32,
          },
        }),
});
```

オンボーディングウィンドウでも同様です。

```typescript
// window-manager.ts (onboarding window)
this.onboardingWindow = new BrowserWindow({
  frame: true,
  ...(process.platform === "linux"
    ? {} // Linux: default frame
    : {
        titleBarStyle: "hidden" as const,
        titleBarOverlay: { /* ... */ },
      }),
});
```

`process.platform === "linux"` のケースでは空オブジェクト `{}` をスプレッドするだけなので、何も追加されず `frame: true` がそのまま残ります。シンプルですが確実な方法です。

---

## 5. LinuxHelper — ヘルパープロセスの役割

macOSには`SwiftHelper`（Swift製）、Windowsには`WindowsHelper.exe`がありますが、Linuxには当初ネイティブヘルパーが存在しませんでした。新たに **LinuxHelper** をTypeScript（Node.js）で作成しました。

### アーキテクチャ

LinuxHelperは子プロセスとして起動され、stdin/stdout経由のJSON-RPCでElectron本体と通信します。

```typescript
// main.ts (LinuxHelper)
import { startKeyboardMonitor } from "./evdev/monitor.js";

// Start evdev keyboard monitoring in parallel
startKeyboardMonitor();

// Read JSON-RPC requests from stdin (one JSON object per line)
const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

rl.on("line", (line: string) => {
  const request = JSON.parse(line.trim());
  dispatch(request);
});
```

### 提供するRPCメソッド

| メソッド | 役割 |
|---|---|
| `pasteText` | クリップボード操作+ペーストキーストローク |
| `startRecording` | 録音開始（通知音再生、システムミュート） |
| `stopRecording` | 録音停止（ミュート解除、通知音再生） |
| `setShortcuts` | ショートカットキー設定の受け渡し |
| `recheckPressedKeys` | 押下中キーの再確認 |
| `getAccessibilityContext` | アクティブウィンドウの情報取得 |
| `getAccessibilityStatus` | 必要なコマンド・権限のチェック |

### アクティブウィンドウの取得

GNOMEのD-Bus経由でアクティブウィンドウの情報を取得します。

```typescript
// handlers/accessibility.ts
async function getGnomeActiveWindow() {
  const script = `
    (function() {
      let w = global.display.get_focus_window();
      if (!w) return JSON.stringify({title: null, wmClass: null, pid: 0});
      return JSON.stringify({
        title: w.get_title(),
        wmClass: w.get_wm_class(),
        pid: w.get_pid()
      });
    })()
  `;

  const { stdout } = await execFileAsync("gdbus", [
    "call", "--session",
    "--dest", "org.gnome.Shell",
    "--object-path", "/org/gnome/Shell",
    "--method", "org.gnome.Shell.Eval",
    script,
  ]);
  // ...
}
```

### プラットフォーム検出とヘルパー名の解決

```typescript
// platform.ts
export function getNativeHelperName(): string {
  if (isWindows()) return "WindowsHelper.exe";
  if (isLinux()) return "LinuxHelper";
  return "SwiftHelper";
}

export function getNativeHelperDir(): string {
  if (isWindows()) return "windows-helper";
  if (isLinux()) return "linux-helper-ts";
  return "swift-helper";
}
```

---

## 6. 初期化順序の違い — 録音サービスの遅延初期化

### 問題

Electronアプリの起動時、オンボーディング（初回セットアップ）フローの中でOAuth認証が行われます。Linuxでは、NativeBridge（LinuxHelper）の起動とOAuthのBrowserWindowベースの認証フローが同時に走ると、`amical://` プロトコルハンドラが競合し、second-instanceイベントが発火して認証状態が失われることがありました。

### 解決策：Linuxのみ録音サービスを遅延初期化

```typescript
// app-manager.ts
if (onboardingCheck.needed) {
  // On Linux, defer recording services (NativeBridge/evdev) until after
  // onboarding. The BrowserWindow-based OAuth flow on Linux conflicts
  // with the amical:// protocol handler, causing second-instance launches
  // that lose the pending auth state.
  if (!isLinux()) {
    await this.initializeRecordingServices();
  }
  await onboardingService.startOnboardingFlow();
  await this.windowManager.createOrShowOnboardingWindow();
} else {
  await this.initializeRecordingServices();
  await this.setupWindows();
}
```

開発モードでのオンボーディング完了後も同様に、Linuxではまず録音サービスを初期化してからウィンドウをセットアップします。

```typescript
// app-manager.ts (onboarding completed event)
onboardingService.on("completed", () => {
  if (shouldRelaunch) {
    app.relaunch();
    app.quit();
  } else {
    const setup = isLinux()
      ? this.initializeRecordingServices().then(() => this.setupWindows())
      : this.setupWindows();
    setup.catch((error) => { /* ... */ });
  }
});
```

---

## 7. ショートカットキー設定 — キーイベントの横取りが必要だった理由

### 前提：ショートカットキー変更のUI

本アプリでは、設定画面でPush-to-Talk（押している間だけ録音）やToggle Recording（録音のON/OFF切り替え）などのショートカットキーをユーザーが自由に変更できます。変更UIは「録音モード」方式です。ユーザーが鉛筆アイコンをクリックすると録音状態に入り、実際にキーを押すと、その組み合わせが新しいショートカットとして登録されます。キーを離した瞬間にバリデーションが走り、問題なければ保存されます。

```
[設定画面]
  Push-to-Talk: [Ctrl+Super]  ✏️  ← クリックすると録音開始
                ↓
  Push-to-Talk: [キーを押してください...]  ✕  ← この状態でキーを押す
                ↓
  Push-to-Talk: [Alt+Shift]  ← キーを離すと確定
```

### 問題：Electronの標準キーボードイベントでは対応できない

macOS/Windowsの実装では、ShortcutManagerが各OSのネイティブヘルパー（SwiftHelper / WindowsHelper）からキーイベントを受け取り、ShortcutManagerの`activeKeys`マップで現在押されているキーを追跡しています。設定画面のReactコンポーネント（`ShortcutInput`）は、tRPCのSubscription経由でこの`activeKeys`の変化をリアルタイムで受け取ります。

ここでLinux特有の問題が2つありました。

**1. Electronの`keydown`/`keyup`イベントはウィンドウにフォーカスがあるときしか発火しない**

Push-to-Talkのようなグローバルショートカットは、アプリがバックグラウンドにいても動作しなければなりません。Electronの標準的なキーボードイベントはBrowserWindowにフォーカスがあるときしか取得できず、`globalShortcut` APIでは特定のキーの組み合わせしか登録できません。macOS/Windowsでは各OSのネイティブAPIで低レベルキーフックを実現していましたが、Linuxには同等の仕組みがありません。

**2. evdevキーコードとElectronのキーコードは全く異なる体系**

Linuxカーネルのevdevが送出するキーコードは、macOSのCGEventキーコードやWindowsのVirtual Keyコードとは完全に別の番号体系です。たとえば同じ`A`キーでも、macOS=0、Windows=0x41、evdev=30と全く異なります。ショートカットの設定値はキーコードの配列として保存されるため、**設定画面でのキーキャプチャもevdevキーコードで統一しなければなりません**。

### 解決策：ネイティブヘルパーからのキーイベントストリームを設定画面でもそのまま利用

設計上の鍵は、**ショートカットの実行時（グローバルキー監視）と設定時（UIでのキーキャプチャ）で同じキーイベントソースを使う**ことです。

#### evdevモニター → ShortcutManager → tRPC Subscription → React UI

データの流れは次のようになっています。

```
/dev/input/eventN (evdevデバイス)
    ↓ fs.read() でバイナリを読み取り
LinuxHelper (evdev/monitor.ts)
    ↓ JSON-RPCイベントとしてstdoutに書き出し
NativeBridge (native-bridge-service.ts)
    ↓ "helperEvent" イベントとしてemit
ShortcutManager (shortcut-manager.ts)
    ↓ activeKeysマップを更新、"activeKeysChanged"をemit
tRPC Subscription (settings.ts: activeKeysUpdates)
    ↓ WebSocket経由でレンダラーに配信
ShortcutInput (shortcut-input.tsx)
    ↓ Reactのstateを更新、UIにキーを表示
```

#### ShortcutManagerの「録音モード」

設定画面でキーをキャプチャしている間、ShortcutManagerは`isRecordingShortcut`フラグをONにします。このフラグがONの間はショートカットの実行判定（`checkShortcuts`）がスキップされ、キーイベントは純粋にUIへの配信にのみ使われます。

```typescript
// shortcut-manager.ts
setIsRecordingShortcut(isRecording: boolean) {
  this.isRecordingShortcut = isRecording;
  // ...
}

private checkShortcuts() {
  // Skip shortcut detection when recording shortcuts
  if (this.isRecordingShortcut) {
    return;
  }
  // ...PTT, Toggle等の判定ロジック
}
```

設定画面のReactコンポーネントは、録音開始時にtRPC mutationで`setShortcutRecordingState(true)`を呼び出し、完了・キャンセル時に`false`に戻します。

```typescript
// shortcut-input.tsx
const handleStartRecording = () => {
  onRecordingShortcutChange(true);
  setRecordingStateMutation.mutate(true);  // メインプロセスに通知
};

// tRPCのSubscriptionで、evdev由来のキーイベントをリアルタイム受信
api.settings.activeKeysUpdates.useSubscription(undefined, {
  enabled: isRecordingShortcut,
  onData: (keys: number[]) => {
    const previousKeys = activeKeys;
    setActiveKeys(keys);

    // キーが離されたら → 直前の組み合わせでバリデーション
    if (previousKeys.length > 0 && keys.length < previousKeys.length) {
      const result = validateShortcutFormat(previousKeys);
      if (result.valid && result.shortcut) {
        onChange(result.shortcut);  // 親コンポーネントへ通知
      }
      // ...
    }
  },
});
```

#### Linuxでの修飾キーのハンドリング: flagsChanged

macOSのCGEventでは、修飾キー（Cmd, Ctrl, Shift, Alt）の押下・離上は通常のkeyDown/keyUpではなく `flagsChanged` という別種のイベントとして通知されます。LinuxのevdevモニターではこのmacOS流の設計を踏襲し、修飾キーについては `flagsChanged` イベントとして送出します。

```typescript
// evdev/monitor.ts
if (value === 1) {  // key press
  pressedKeys.add(code);
  emitKeyEvent(
    isModifierKeyCode(code) ? "flagsChanged" : "keyDown",
    code,
  );
} else if (value === 0) {  // key release
  pressedKeys.delete(code);
  emitKeyEvent(
    isModifierKeyCode(code) ? "flagsChanged" : "keyUp",
    code,
  );
}
```

ShortcutManager側では、`flagsChanged`を受け取ったとき、そのキーコードが既に追跡されていれば離上（keyUp相当）、そうでなければ押下（keyDown相当）として処理します。

```typescript
// shortcut-manager.ts
case "flagsChanged":
  // Modifier keys (Ctrl, Shift, Alt, Meta) are sent as flagsChanged.
  // Treat as keyDown if not tracked, keyUp if already tracked.
  if (this.activeKeys.has(event.payload.keyCode)) {
    this.handleKeyUp(event.payload);
  } else {
    this.handleKeyDown(event.payload);
  }
  break;
```

### キーコードのプラットフォーム切り替え

設定画面に表示するキー名も、保存・読み込みのキーコードも、すべてプラットフォーム固有の値です。`getKeyFromKeycode()`関数が実行時にプラットフォームを判定し、適切なマッピングテーブルを選択します。

```typescript
// keycode-map.ts — 3プラットフォーム分のマッピングテーブルを保持
const linuxEvdevToKey: Record<number, string> = {
  29: "Ctrl", 97: "RCtrl",
  42: "Shift", 54: "RShift",
  56: "Alt", 100: "RAlt",
  125: "Cmd",  // Super/Meta left — Cmdと表記して統一
  126: "RCmd",
  57: "Space", 28: "Enter",
  // ...全130以上のキーに対応
};

export function getKeyFromKeycode(keycode: number): string | undefined {
  const mapping = isLinux()
    ? linuxEvdevToKey
    : isWindows()
      ? windowsVKToKey
      : macOSKeycodeToKey;
  return mapping[keycode];
}
```

### バリデーションの統一

ショートカットのバリデーション（OS予約済みショートカットとの衝突チェック、修飾キーの重複チェックなど）は`shortcut-validation.ts`に集約されています。Linux版では現時点でOS予約済みショートカットのチェックは省略されていますが（Linuxのデスクトップ環境ごとに予約されるショートカットが大きく異なるため）、その他のチェック（最大キー数、他のショートカットとの重複、修飾キーなしの英数字のみ禁止など）は全プラットフォーム共通で適用されます。

### まとめ

通常のElectronアプリでは、設定画面でのキーバインド変更はブラウザの`keydown`イベントを`addEventListener`で拾えば済みます。しかし本アプリでは以下の理由から、evdevという低レベルなキーイベントソースをそのまま設定画面にも利用する設計になっています。

1. **キーコードの一貫性** --- ショートカットの実行時（バックグラウンド）と設定時（フォアグラウンド）で同じevdevキーコードを使わないと、保存したショートカットが正しく発火しない
2. **修飾キー単独の検出** --- ブラウザの`keydown`では`Ctrl`単押しのようなイベントは不安定で、`keyup`のタイミングも信頼できない。evdevなら確実に検出できる
3. **全プラットフォーム同一アーキテクチャ** --- macOS/Windows/Linuxすべてで「ネイティブヘルパー → ShortcutManager → tRPC Subscription → React UI」という同じパイプラインを通る。プラットフォーム分岐はヘルパーとキーコードマッピングに閉じ込め、UIコンポーネントのコードは完全に共通

---

## まとめ

Electron製アプリのLinux移植で遭遇した主な問題と対策をまとめます。

| 領域 | 問題 | 対策 |
|---|---|---|
| クリップボード | `wl-copy`の非同期性によるレースコンディション | Electron clipboard APIで同期書き込み、ヘルパーはキーストロークのみ |
| ペースト | `Ctrl+V`がターミナルで動かない | `Shift+Insert`を採用（GUI+ターミナル両対応） |
| キー入力監視 | グローバルキーフック相当の仕組みがない | evdevデバイスの直接読み取り（`input`グループ必須） |
| キーコード | OS間でキーコード体系が異なる | 3プラットフォーム分のマッピングテーブル |
| ショートカット設定UI | ブラウザのkeydownでは修飾キー単独検出が不安定 | evdevイベントをtRPC Subscriptionで設定UIに直接配信 |
| 通知音 | 統一的な音声再生APIがない | `gst-play-1.0`をdetachedプロセスで起動 |
| システムミュート | 録音中のフィードバック防止 | `pactl`でデフォルトシンクをミュート/アンミュート |
| ウィンドウ | カスタムタイトルバーが正常に描画されない | Linuxではデフォルトのウィンドウフレームを使用 |
| ヘルパー | OS固有機能の実行 | TypeScript製LinuxHelper（JSON-RPC over stdin/stdout） |
| 初期化順序 | OAuth認証とプロトコルハンドラの競合 | Linux限定で録音サービスの遅延初期化 |
| アクティブウィンドウ | ウィンドウ情報の取得方法がOS依存 | GNOME D-Bus eval経由で取得 |

### 外部依存ツール

Linux版の動作には以下のツールが必要です：

- **ydotool** --- キーストロークのシミュレーション
- **wl-copy / wl-paste** --- Waylandクリップボード操作（フォールバック用）
- **gst-play-1.0** --- MP3音声ファイルの再生
- **pactl** --- PulseAudio/PipeWireのシンク制御
- **gdbus** --- GNOME Shell D-Bus通信

Electronは「Write once, run anywhere」と言われがちですが、OS固有機能に依存する部分ではプラットフォームごとの対応が欠かせません。特にLinuxでは、Wayland移行期ならではの課題（X11時代の`xdotool`は使えず`ydotool`が必要、クリップボードが`wl-copy`ベース、など）に直面しました。

本記事がElectronアプリのLinux対応を検討されている方の参考になれば幸いです。
