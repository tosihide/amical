# Linux パッケージビルドガイド (.deb / AppImage)

---

> **TL;DR — よく使うコマンド**
>
> | やりたいこと | コマンド |
> |------------|---------|
> | 開発起動 | `ELECTRON_DISABLE_SANDBOX=1 pnpm start` (または `./run.sh`) |
> | パッケージビルド | `cd apps/desktop && pnpm make:linux` |
> | 初回のみ | `pnpm download-node && convert assets/logo.svg -resize 256x256 assets/logo.png` |
>
> **重要:** `electron-forge make` に `--targets` フラグは使わないこと。  
> `forge.config.ts` のカスタム設定が無視され、ビルドが失敗する（[詳細](#23-問題3---targets-フラグ使用時に-maker-の設定が無視される)）。

---

## 概要

Amical Desktop の Ubuntu/Debian 向け配布パッケージのビルド手順と、
ビルド環境構築時に発見された問題点・解決策をまとめたドキュメント。

2種類のパッケージ形式に対応している:

| 形式 | ファイル | インストール方法 | sudo | 用途 |
|------|---------|----------------|------|------|
| `.deb` | `amical_1.1.0_amd64.deb` | `dpkg -i` | 必要 | システムインストール |
| AppImage | `Amical-1.1.0-x64.AppImage` | ファイルに実行権限を付けて起動 | 不要 | ユーザーインストール（ポータブル） |

---

## 1. ビルド手順

> **24.04 でビルドすれば 24.04・26.04 の両方に対応できます。**
> 24.04（glibc 2.39）でビルドしたパッケージは glibc の前方互換性により
> 24.04・26.04 の両方で動作するため、1 つのパッケージで両リリースをカバーできます。
> 一方、26.04 でビルドすると新しい glibc にリンクされ、**24.04 では起動できません**。
> ydotool の v0.1.x（24.04）と v1.x（26.04）の差分は
> `linux-helper-ts/src/handlers/paste-text.ts` で実行時に吸収済みのため、
> ペースト動作のためにリリースごとのパッケージを分ける必要はありません。

### 1.1 前提条件

- Ubuntu 24.04 LTS (amd64)
- Node.js v22.x
- pnpm 10.x
- 必要なシステムパッケージ:

```bash
sudo apt install dpkg fakeroot imagemagick
```

### 1.2 共通の事前準備（初回のみ）

```bash
cd apps/desktop

# Node.js バイナリのダウンロード
pnpm download-node

# アイコン用 PNG の生成（logo.png が存在しない場合）
convert assets/logo.svg -resize 256x256 assets/logo.png
```

### 1.3 パッケージのビルド

以下のコマンドで `.deb` と AppImage の両方が同時にビルドされる:

```bash
cd apps/desktop
pnpm make:linux
```

内部では `pnpm build:deps && pnpm build:linux-helper && SKIP_RPM=true electron-forge make --platform=linux --arch=x64` が実行される。

### 1.4 出力先

```
apps/desktop/out/make/deb/x64/amical_1.1.0_amd64.deb        # 143 MB
apps/desktop/out/make/AppImage/x64/Amical-1.1.0-x64.AppImage # 196 MB
```

### 1.5 インストール方法

#### .deb パッケージ（システムインストール）

```bash
sudo dpkg -i out/make/deb/x64/amical_1.1.0_amd64.deb
sudo apt-get install -f   # 不足する依存パッケージがあれば自動インストール
```

- アプリケーションメニューまたはコマンドラインの `Amical` で起動
- **開発時に必要だった `ELECTRON_DISABLE_SANDBOX=1` は不要**
  （`.deb` では `chrome-sandbox` に SUID ビットが正しく設定される）
- アンインストール: `sudo apt remove amical`

#### AppImage（ユーザーインストール）

```bash
# 任意の場所にコピー（例: ~/Applications/）
mkdir -p ~/Applications
cp out/make/AppImage/x64/Amical-1.1.0-x64.AppImage ~/Applications/

# 実行権限を付与して起動
chmod +x ~/Applications/Amical-1.1.0-x64.AppImage
~/Applications/Amical-1.1.0-x64.AppImage
```

- sudo 不要。単一ファイルで完結するポータブル形式
- 削除はファイルを消すだけ
- `--no-sandbox` フラグが自動付与されるため、追加の設定は不要
- デスクトップ統合（メニュー登録等）が必要な場合は
  [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher) の利用を推奨

### 1.6 pnpm スクリプトによるビルド

`package.json` に定義済みのスクリプトでもビルドできるが、
RPM も同時にビルドしようとするため `rpmbuild` が必要になる:

```bash
# RPM も含めてビルドする場合（要 rpmbuild: sudo apt install rpm）
pnpm make:linux

# RPM をスキップして .deb + AppImage のみビルドする場合
SKIP_RPM=true pnpm exec electron-forge make --platform=linux --arch=x64
```

---

## 2. 調査経緯と解決した問題

### 2.1 問題1: rpmbuild が見つからない

**現象:**
`pnpm make:linux` を実行すると以下のエラーで失敗:

```
Cannot make for rpm, the following external binaries need to be installed: rpmbuild
```

**原因:**
`forge.config.ts` の `makers` 配列に `MakerRpm` が含まれており、
`rpmbuild` コマンドが存在しないと全体が失敗する。

**解決策:**
`forge.config.ts` で `MakerRpm` を環境変数 `SKIP_RPM` で条件付きに変更:

```typescript
// forge.config.ts (変更後)
...(process.env.SKIP_RPM !== "true"
  ? [
      new MakerRpm({
        options: { ... },
      }),
    ]
  : []),
```

---

### 2.2 問題2: Node.js バイナリが見つからない

**現象:**
`electron-forge make` の prePackage フックで以下のエラー:

```
✗ Node.js binary not found for linux-x64
  Please run 'pnpm download-node' or 'pnpm download-node:all' first
```

**原因:**
Amical はメインプロセスとは別に Node.js を子プロセスとして使用しており（Whisper worker 等）、
プラットフォーム固有の Node.js バイナリを `node-binaries/` ディレクトリに同梱する必要がある。

**解決策:**

```bash
pnpm download-node
```

これにより `apps/desktop/node-binaries/linux-x64/node` にバイナリがダウンロードされる。

---

### 2.3 問題3: `--targets` フラグ使用時に Maker の設定が無視される

**現象:**
`--targets=@electron-forge/maker-deb` を指定してビルドすると、
`forge.config.ts` で設定した `bin`, `name` 等のオプションが全て無視され、
以下のエラーが発生:

```
could not find the Electron app binary at
"/.../out/Amical-linux-x64/@amical/desktop"
```

バイナリ名が `Amical` であるべきところ、package.json の `name`（`@amical/desktop`）が使われている。

**原因:**
`electron-forge` の `make.js` 内の `generateTargets` 関数の挙動:

```javascript
// node_modules/@electron-forge/core/dist/api/make.js (24-34行目)
function generateTargets(forgeConfig, overrideTargets) {
    if (overrideTargets) {
        return overrideTargets.map((target) => {
            if (typeof target === 'string') {
                // maker.name は 'deb' だが target は '@electron-forge/maker-deb'
                // → マッチしないため { name: target } （設定なし）が返される
                return forgeConfig.makers.find((maker) => maker.name === target)
                    || { name: target };
            }
            return target;
        });
    }
    return forgeConfig.makers;
}
```

`--targets=@electron-forge/maker-deb` で指定した名前は NPM パッケージ名だが、
`forgeConfig.makers.find()` は `maker.name`（= `'deb'`）と比較する。
名前が一致しないため、**設定なしの新しい MakerDeb インスタンスが作られる。**

設定なしの場合、`electron-installer-common` のデフォルト値生成ロジックにより:

```javascript
// node_modules/electron-installer-common/src/defaults.js (15行目)
bin: pkg.name || 'electron',  // → '@amical/desktop'
```

ASAR 内の `package.json` の `name` フィールドがバイナリ名として使われてしまう。

**デバッグの過程:**

1. `electron-installer-debian` と `MakerDeb` にデバッグログを追加
2. `this.config` と `this.configOrConfigFetcher` が共に `{}` であることを確認
3. `_.defaults()` のマージ順を検証し、config 自体が空であることが根本原因と特定
4. `generateTargets` の名前マッチングロジックを発見

**解決策:**
`--targets` フラグを使わず、`forge.config.ts` から不要な Maker を条件付きで除外して
`electron-forge make` を実行する。

---

### 2.4 問題4: PNG アイコンが存在しない

**現象:**
```
The icon "./assets/logo.png" does not exist
```

**原因:**
`MakerDeb` の設定で `icon: "./assets/logo.png"` を指定したが、
リポジトリには `.icns`, `.ico`, `.svg` のみが存在し PNG がなかった。

**解決策:**
ImageMagick で SVG から PNG を生成:

```bash
convert assets/logo.svg -resize 256x256 assets/logo.png
```

> 注: ImageMagick の SVG レンダリングは限定的なため、
> 正式なアイコンはデザインツールで別途作成することを推奨する。

---

## 3. forge.config.ts の変更箇所

### MakerDeb の設定追加

```typescript
new MakerDeb({
  options: {
    bin: "Amical",           // 実行バイナリ名（必須）
    name: "amical",          // Debian パッケージ名
    productName: "Amical",   // 表示名
    genericName: "Dictation App",
    categories: ["Utility", "Audio"],
    description: "AI-powered dictation and note-taking",
    depends: ["libgtk-3-0", "libnotify4", "libnss3", "libxss1", "libsecret-1-0"],
    recommends: ["wl-clipboard", "ydotool"],
    icon: "./assets/logo.png",
    mimeType: ["x-scheme-handler/amical"],
  },
}),
```

`bin: "Amical"` が最も重要な設定。
これがないと `package.json` の `name`（`@amical/desktop`）がバイナリ名として使われ、
インストーラーがパッケージ済みバイナリを見つけられずにエラーになる。

### MakerAppImage の追加

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

- コミュニティパッケージ `@reforged/maker-appimage` を使用
  （公式の `@electron-forge/maker-appimage` は存在しない）
- `devDependencies` に追加済み

### MakerRpm の条件付き読み込み

```typescript
...(process.env.SKIP_RPM !== "true"
  ? [new MakerRpm({ ... })]
  : []),
```

---

## 4. 生成されるパッケージの情報

### .deb パッケージ

```
Package: amical
Version: 1.1.0
Architecture: amd64
Installed-Size: ~525 MB
Depends: libgtk-3-0, libnotify4, libnss3, xdg-utils, libatspi2.0-0,
         libdrm2, libgbm1, libxcb-dri3-0, libxss1, libsecret-1-0,
         kde-cli-tools | kde-runtime | trash-cli | libglib2.0-bin | gvfs-bin
Recommends: pulseaudio | libasound2, wl-clipboard, ydotool
Maintainer: Amical <contact@amical.ai>
Homepage: https://amical.ai
Description: AI-powered dictation and note-taking
```

### AppImage

```
ファイル名: Amical-1.1.0-x64.AppImage
サイズ: 196 MB
形式: ELF 64-bit, static-pie linked
対象: x86-64 Linux
```

AppImage は全ての依存ライブラリを内包するため `.deb` より大きい。

---

## 5. .deb と AppImage の比較

| 観点 | .deb | AppImage |
|------|------|----------|
| インストール | `sudo dpkg -i` | ファイルを置いて `chmod +x` |
| root 権限 | 必要 | 不要 |
| アンインストール | `sudo apt remove amical` | ファイルを削除 |
| デスクトップ統合 | 自動（メニュー、アイコン） | 手動 or AppImageLauncher |
| サンドボックス | SUID で有効 | `--no-sandbox` で動作 |
| 自動更新 | apt 経由（リポジトリ登録時） | 非対応（手動差し替え） |
| 配布サイズ | 143 MB | 196 MB |
| 依存関係 | apt が管理 | 全て内包 |

**推奨:**
- 自分の PC にインストールする場合 → `.deb`
- 他の人に渡す・USB で持ち運ぶ場合 → AppImage

---

## 6. 既知の注意事項

- `--targets` フラグを使うと `forge.config.ts` のカスタム設定が無視される
  （electron-forge の既知の動作。makers 配列の `name` プロパティと
  `--targets` の NPM パッケージ名が一致しないため）
- RPM パッケージのビルドには `rpmbuild` が必要（`sudo apt install rpm`）
- PNG アイコンはリポジトリに含まれていないため、ビルド前に生成が必要
- サンドボックスは `.deb` インストール時に自動で有効になる
  （`chrome-sandbox` に SUID ビットが設定される）
- AppImage は `@reforged/maker-appimage`（コミュニティパッケージ）を使用している
