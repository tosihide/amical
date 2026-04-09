# Electron Forgeで.debとAppImageを同時ビルド -- Linuxパッケージング実践ガイド

## 導入

Electron アプリを Linux 向けに配布するとき、`.deb`（Debian/Ubuntu系）と AppImage（ディストロ非依存のポータブル形式）の2種類を用意できると、ユーザーの選択肢が広がる。

本記事では、**Electron Forge** を使ってこの2形式を1コマンドで同時ビルドする方法を、実際のプロジェクト（Amical Desktop -- AI 音声入力アプリ）の構成をベースに解説する。モノレポ構成でネイティブモジュールを含むケースでの落とし穴と、それぞれの解決策も取り上げる。

### 技術スタック

| 要素 | バージョン/ツール |
|------|-----------------|
| Electron | 38.x |
| Electron Forge | 7.8.2 |
| ビルドツール | Vite（VitePlugin経由） |
| パッケージマネージャ | pnpm 10.x |
| Node.js | 22.x |
| 対象OS | Ubuntu 24.04 LTS (amd64) |

---

## ビルドパイプライン

パッケージビルドは `pnpm make:linux` の1コマンドで実行できる。内部では3段階のパイプラインが走る。

```
pnpm make:linux
  |
  +-- 1. pnpm build:deps         # 依存パッケージのビルド
  |     +-- build:types           # @amical/types（共有型定義）
  |     +-- build:native-helper   # プラットフォーム別ヘルパー（Linuxでは何もしない）
  |
  +-- 2. pnpm build:linux-helper  # Linux専用ヘルパーのビルド
  |
  +-- 3. SKIP_RPM=true electron-forge make --platform=linux --arch=x64
        +-- prePackage フック      # Node.jsバイナリのコピー、依存モジュール解決
        +-- Vite ビルド            # main/preload/rendererの各エントリ
        +-- パッケージング          # ASAR作成、extraResourceコピー
        +-- postPackage フック     # プラットフォーム別の後処理
        +-- Maker実行             # .deb と AppImage の生成
```

### package.json のスクリプト定義

```jsonc
{
  "scripts": {
    // 開発起動
    "start": "pnpm build:deps && electron-forge start",

    // Linuxパッケージビルド（.deb + AppImage）
    "make:linux": "pnpm build:deps && pnpm build:linux-helper && SKIP_RPM=true electron-forge make --platform=linux --arch=x64",

    // パッケージのみ（Maker実行なし = .debやAppImage生成なし）
    "package:linux": "pnpm build:deps && pnpm build:linux-helper && electron-forge package --platform=linux --arch=x64",

    // 依存ビルド
    "build:deps": "pnpm build:types && pnpm build:native-helper",
    "build:linux-helper": "cd ../../packages/native-helpers/linux-helper-ts && npm run build",

    // プラットフォーム判定で適切なヘルパーをビルド
    "build:native-helper": "node -e \"const s = process.platform === 'darwin' ? 'build:swift-helper' : process.platform === 'win32' ? 'build:windows-helper' : ''; if (s) { require('child_process').execSync('pnpm run ' + s, {stdio:'inherit'}); } else { console.log('No native helpers'); }\""
  }
}
```

`build:native-helper` は Linux 上では何もしない（`No native helpers` と表示して終了）。代わりに `build:linux-helper` が Linux 専用のネイティブヘルパーをビルドする。この2段構えになっている理由は、`linux-helper-ts` がモノレポのワークスペースパッケージではなく独立した npm プロジェクトとして管理されているためだ。

---

## Electron Forge 設定

`forge.config.ts` が全体の設定ファイルとなる。主要な構成要素を順に見ていく。

### Makers（パッケージ形式の定義）

```typescript
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerAppImage } from "@reforged/maker-appimage";

const config: ForgeConfig = {
  makers: [
    // Windows
    new MakerSquirrel({ name: "Amical", setupIcon: "./assets/logo.ico" }),
    // macOS
    new MakerZIP({}, ["darwin"]),
    new MakerDMG({ icon: "./assets/logo.icns", background: "./assets/dmg_bg.tiff" }, ["darwin"]),
    // Linux: RPM（条件付き）
    ...(process.env.SKIP_RPM !== "true"
      ? [new MakerRpm({ options: { categories: ["Utility", "Audio"], description: "..." } })]
      : []),
    // Linux: deb
    new MakerDeb({ options: { /* 後述 */ } }),
    // Linux: AppImage
    new MakerAppImage({ options: { /* 後述 */ } }),
  ],
};
```

全プラットフォームの Maker が1つの配列に共存しており、`electron-forge make --platform=linux` を実行すると Linux 対応の Maker だけが自動選択される。

### Plugins（Vite + Fuses）

```typescript
plugins: [
  new VitePlugin({
    build: [
      { entry: "src/main/main.ts",           config: "vite.main.config.mts",   target: "main" },
      { entry: "src/main/preload.ts",         config: "vite.preload.config.mts", target: "preload" },
      { entry: "src/main/onboarding-preload.ts", config: "vite.onboarding-preload.config.mts", target: "preload" },
    ],
    renderer: [
      { name: "main_window",          config: "vite.renderer.config.mts" },
      { name: "widget_window",        config: "vite.widget.config.mts" },
      { name: "notes_widget_window",  config: "vite.notes-widget.config.mts" },
      { name: "onboarding_window",    config: "vite.onboarding.config.mts" },
    ],
  }),
  new FusesPlugin({
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // ...
  }),
],
```

`FusesPlugin` により、パッケージ時に Electron のセキュリティ設定がバイナリレベルで焼き込まれる。`RunAsNode: false` は `ELECTRON_RUN_AS_NODE` 環境変数を無効化し、配布バイナリの悪用を防ぐ。

---

## SKIP_RPM フラグの経緯

### 問題

`electron-forge make` は `makers` 配列にある全 Maker を順に実行する。`MakerRpm` が含まれていると `rpmbuild` コマンドの存在チェックが行われ、インストールされていない Ubuntu 環境では即座にビルド全体が失敗する。

```
Cannot make for rpm, the following external binaries need to be installed: rpmbuild
```

Ubuntu で RPM をビルドすることは稀なので、`sudo apt install rpm` で `rpmbuild` を入れるのはオーバーヘッドが大きい。

### 解決策: 環境変数による条件分岐

```typescript
// forge.config.ts
...(process.env.SKIP_RPM !== "true"
  ? [
      new MakerRpm({
        options: {
          categories: ["Utility", "Audio"],
          description: "AI-powered dictation and note-taking",
        },
      }),
    ]
  : []),
```

`package.json` の `make:linux` スクリプトに `SKIP_RPM=true` を埋め込むことで、Ubuntu 環境ではデフォルトで RPM ビルドがスキップされる。

```jsonc
"make:linux": "pnpm build:deps && pnpm build:linux-helper && SKIP_RPM=true electron-forge make --platform=linux --arch=x64"
```

> **注意:** `SKIP_RPM` の判定は `!== "true"` であり、**環境変数が未設定の場合は RPM がビルドされる**。CI/CD で Fedora/RHEL 向けにも配布する場合はこの挙動がデフォルトとして正しい。

---

## prePackage フック -- ビルド前の重要な処理

`forge.config.ts` の `hooks.prePackage` は、Electron Forge がアプリをパッケージングする前に実行される。このプロジェクトでは複数の重要な処理を担っている。

### 1. Node.js バイナリの存在チェック

```typescript
prePackage: async (_forgeConfig, platform, arch) => {
  const nodeBinarySource = join(projectRoot, "node-binaries", `${platform}-${arch}`, "node");
  if (!existsSync(nodeBinarySource)) {
    throw new Error(`Missing Node.js binary for ${platform}-${arch}`);
  }
}
```

Amical は Whisper ワーカーなどを子プロセスとして起動するため、プラットフォーム固有の Node.js バイナリを同梱する必要がある。事前に `pnpm download-node` でダウンロードしておく。

### 2. モノレポ依存モジュールの解決

```typescript
export const EXTERNAL_DEPENDENCIES = [
  "electron-squirrel-startup",
  "@libsql/client",
  "@libsql/linux-x64-gnu",
  "libsql",
  "onnxruntime-node",
  "@amical/whisper-wrapper",
  // ...
];
```

モノレポでは `node_modules` がルートにホイストされるため、Electron Forge のデフォルトのモジュール解決では見つからない。`flora-colossus`（Electron Forge の内部依存）を使って各モジュールのネストされた依存関係を再帰的に探索し、ローカルの `node_modules` にコピーする。

```typescript
// flora-colossus で依存ツリーを歩く
const walker = new Walker(monorepoRoot);
await walker.walkDependenciesForModule(moduleRoot, DepType.PROD);
```

### 3. 不要なバイナリの刈り込み（Pruning）

`onnxruntime-node` は全プラットフォームのバイナリを含んでおり、そのままだとパッケージサイズが肥大化する。ターゲットプラットフォーム以外のバイナリを削除する。

```typescript
// 不要なプラットフォームのバイナリを削除
if (platformDir !== targetPlatform && platformDir !== "linux") {
  rmSync(platformPath, { recursive: true, force: true });
}
```

同様に、`@amical/whisper-wrapper` の `whisper.cpp` ソースコードや `build` ディレクトリも削除する。

### 4. シンボリックリンクの実体化

pnpm のモノレポではワークスペースパッケージがシンボリックリンクで配置される。ASAR パッケージングではシンボリックリンクが正しく処理されないため、実ファイルに置き換える。

```typescript
if (stats.isSymbolicLink()) {
  const symlinkTarget = readlinkSync(localDepPath);
  rmSync(localDepPath, { recursive: true, force: true });
  cpSync(sourcePath, localDepPath, { recursive: true, dereference: true });
}
```

---

## postPackage フック

`postPackage` はパッケージング完了後に実行される。現在の実装では Windows 向けに VC++ ランタイム DLL をバンドルする処理が入っている。

```typescript
postPackage: async (_forgeConfig, options) => {
  const { outputPaths, platform } = options;
  if (platform === "win32") {
    const vcRuntimeDlls = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];
    for (const outputPath of outputPaths) {
      for (const dll of vcRuntimeDlls) {
        copyFileSync(`C:\\Windows\\System32\\${dll}`, join(outputPath, dll));
      }
    }
  }
}
```

Linux 向けには現時点で postPackage での追加処理はないが、`.deb` パッケージでは `chrome-sandbox` に SUID ビットが自動設定されるため、インストール後の `ELECTRON_DISABLE_SANDBOX=1` が不要になる。

> **メモ:** `packagerConfig` で `prune: false` が設定されているため、`packageAfterPrune` フックは実行されない。コード上には空ディレクトリ削除のロジックが残っているが、これは現在デッドコードとなっている。

---

## LinuxHelper のビルド

`build:linux-helper` は Linux 固有のネイティブヘルパープロセスをビルドするスクリプトだ。

```jsonc
"build:linux-helper": "cd ../../packages/native-helpers/linux-helper-ts && npm run build"
```

### LinuxHelper の役割

LinuxHelper は独立した Node.js プロセスとして動作し、Electron メインプロセスと JSON-RPC で通信する。

```
Electron (メインプロセス)  <--stdin/stdout JSON-RPC-->  LinuxHelper
```

主な機能:

- **evdev キーボード監視** -- `/dev/input/event*` を直接読み取り、グローバルショートカットを検出する（X11/Wayland 両対応）
- **アクセシビリティ操作** -- `ydotool` や `wl-clipboard` を使ったキー入力シミュレーションとクリップボード操作

### ビルドの仕組み

```jsonc
// packages/native-helpers/linux-helper-ts/package.json
{
  "scripts": {
    "build": "tsc && chmod +x bin/LinuxHelper"
  }
}
```

TypeScript をコンパイルし、エントリポイントスクリプト `bin/LinuxHelper` に実行権限を付与する。ビルド成果物は `extraResource` 経由でパッケージに同梱される。

```typescript
// forge.config.ts > packagerConfig > extraResource
...(process.platform === "linux"
  ? [
      "../../packages/native-helpers/linux-helper-ts/bin",
      "../../packages/native-helpers/linux-helper-ts/dist",
      "../../packages/native-helpers/linux-helper-ts/resources",
    ]
  : [/* macOS/Windows のヘルパー */]),
```

---

## AppImage 固有の設定

AppImage の生成にはコミュニティパッケージ `@reforged/maker-appimage` を使用する。公式の `@electron-forge/maker-appimage` は存在しない。

```typescript
import { MakerAppImage } from "@reforged/maker-appimage";

new MakerAppImage({
  options: {
    bin: "Amical",
    name: "Amical",
    icon: "./assets/logo.png",
    categories: ["Utility", "Audio"],
    genericName: "Dictation App",
    mimeType: ["x-scheme-handler/amical"],
  },
}),
```

### 重要なポイント

- **`bin: "Amical"` は必須。** これを省略すると `package.json` の `name`（`@amical/desktop`）がバイナリ名として使われ、パッケージ内のバイナリが見つからずエラーになる
- AppImage は `--no-sandbox` フラグが自動付与されるため、SUID の設定は不要
- 全ての依存ライブラリを内包するため、`.deb` より大きい（約196MB vs 143MB）

### インストール方法

```bash
chmod +x Amical-1.1.0-x64.AppImage
./Amical-1.1.0-x64.AppImage
```

sudo 不要。削除もファイルを消すだけ。

---

## deb パッケージ固有の設定

```typescript
new MakerDeb({
  options: {
    bin: "Amical",           // 実行バイナリ名（最重要）
    name: "amical",          // Debian パッケージ名（小文字）
    productName: "Amical",   // 表示名
    genericName: "Dictation App",
    categories: ["Utility", "Audio"],
    description: "AI-powered dictation and note-taking",
    depends: [
      "libgtk-3-0",
      "libnotify4",
      "libnss3",
      "libxss1",
      "libsecret-1-0",
    ],
    recommends: ["wl-clipboard", "ydotool"],
    icon: "./assets/logo.png",
    mimeType: ["x-scheme-handler/amical"],
  },
}),
```

### 各オプションの意味

| オプション | 説明 |
|-----------|------|
| `bin` | パッケージ内の実行バイナリ名。`packagerConfig.executableName` と一致させる |
| `name` | Debian パッケージ名。`dpkg -l` で表示される名前。小文字のみ |
| `depends` | `dpkg` が依存パッケージとしてチェックするライブラリ群 |
| `recommends` | インストール推奨パッケージ（Wayland 環境用のクリップボードツールなど） |
| `mimeType` | カスタム URL スキーム（`amical://`）の登録 |

### `--targets` フラグの罠

`electron-forge make --targets=@electron-forge/maker-deb` のように `--targets` を指定すると、**`forge.config.ts` のカスタム設定が無視される。**

原因は Electron Forge 内部の `generateTargets` 関数にある。

```javascript
// @electron-forge/core/dist/api/make.js
function generateTargets(forgeConfig, overrideTargets) {
  if (overrideTargets) {
    return overrideTargets.map((target) => {
      if (typeof target === 'string') {
        // maker.name は 'deb' だが target は '@electron-forge/maker-deb'
        // --> マッチしないため設定なしの Maker が生成される
        return forgeConfig.makers.find((maker) => maker.name === target)
            || { name: target };
      }
      return target;
    });
  }
  return forgeConfig.makers;
}
```

`--targets` に渡す名前は NPM パッケージ名（`@electron-forge/maker-deb`）だが、`makers.find()` は `maker.name`（= `'deb'`）と比較する。名前が一致しないため、**空の設定で新しい Maker が作られてしまう。**

**対策: `--targets` フラグは使わない。** 不要な Maker は `SKIP_RPM` のように環境変数で除外する。

---

## 実行方法まとめ

### 開発時

```bash
# 方法1: run.sh を使用
./run.sh

# 方法2: 直接実行
cd apps/desktop && ELECTRON_DISABLE_SANDBOX=1 pnpm start
```

`ELECTRON_DISABLE_SANDBOX=1` は開発時のみ必要。`chrome-sandbox` に SUID ビットが設定されていないため。

### パッケージビルド（配布パッケージなし）

```bash
cd apps/desktop && pnpm package:linux
```

`out/Amical-linux-x64/` にパッケージされたアプリが出力される。Maker は実行されないため `.deb` や AppImage は生成されない。動作確認用。

### 配布パッケージの生成

```bash
cd apps/desktop && pnpm make:linux
```

出力先:

```
out/make/deb/x64/amical_1.1.0_amd64.deb        # ~143 MB
out/make/AppImage/x64/Amical-1.1.0-x64.AppImage # ~196 MB
```

### 初回セットアップ（事前準備）

```bash
# Node.js バイナリのダウンロード
pnpm download-node

# PNG アイコンの生成（リポジトリには SVG のみ）
sudo apt install imagemagick
convert assets/logo.svg -resize 256x256 assets/logo.png

# deb ビルドに必要なツール
sudo apt install dpkg fakeroot
```

---

## トラブルシューティング

### `rpmbuild` が見つからない

```
Cannot make for rpm, the following external binaries need to be installed: rpmbuild
```

`SKIP_RPM=true` を付けてビルドする。`pnpm make:linux` はデフォルトでこのフラグが設定済み。

```bash
SKIP_RPM=true electron-forge make --platform=linux --arch=x64
```

### Node.js バイナリが見つからない

```
Node.js binary not found for linux-x64
```

```bash
pnpm download-node
```

### PNG アイコンが存在しない

```
The icon "./assets/logo.png" does not exist
```

```bash
convert assets/logo.svg -resize 256x256 assets/logo.png
```

### `--targets` 指定時にバイナリが見つからない

```
could not find the Electron app binary at ".../out/Amical-linux-x64/@amical/desktop"
```

`--targets` フラグを使わないこと。`forge.config.ts` の Maker 設定が無視され、`package.json` の `name`（`@amical/desktop`）がバイナリ名として使われてしまう。

### サンドボックスエラー（開発時）

```
The SUID sandbox helper binary was found, but is not configured correctly.
```

```bash
ELECTRON_DISABLE_SANDBOX=1 pnpm start
```

`.deb` でインストールした場合は `chrome-sandbox` に SUID が自動設定されるため、この問題は発生しない。

### モノレポでネイティブモジュールが見つからない

`packagerConfig.prune` が `false` に設定されており、`packagerConfig.ignore` 関数で必要なモジュールのみをホワイトリスト方式で同梱している。新しいネイティブモジュールを追加した場合は `EXTERNAL_DEPENDENCIES` 配列に追加する必要がある。

```typescript
export const EXTERNAL_DEPENDENCIES = [
  "new-native-module",  // ここに追加
  // ...
];
```

---

## まとめ

Electron Forge で Linux 向けの `.deb` と AppImage を同時ビルドする際の要点:

1. **`bin` オプションは必ず設定する。** 省略すると `package.json` の `name` がバイナリ名に使われ、スコープ付きパッケージ名（`@scope/name`）の場合にパスが壊れる
2. **`--targets` フラグは使わない。** Maker の設定が無視される Electron Forge の既知の挙動がある。不要な Maker は環境変数で条件分岐する
3. **`SKIP_RPM=true` で RPM ビルドをスキップ。** Ubuntu 環境に `rpmbuild` を入れる必要がなくなる
4. **モノレポでは依存解決に工夫が必要。** `flora-colossus` でネストされた依存を再帰探索し、シンボリックリンクを実体化する
5. **AppImage は `@reforged/maker-appimage` を使う。** 公式 Maker は存在しないため、コミュニティパッケージに頼る
6. **開発時は `ELECTRON_DISABLE_SANDBOX=1` が必要。** `.deb` インストール後は不要

これらの知見は、Electron Forge + モノレポ + ネイティブモジュールという組み合わせで Linux パッケージングに取り組む際の参考になれば幸いだ。
