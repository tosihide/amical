# Electronアプリの sandbox 問題を理解する — ELECTRON_DISABLE_SANDBOX が必要な理由と各パッケージ形式での対策

---

> **対象読者:** Linux で Electron アプリを開発・配布している人。特に `.deb`、AppImage、開発モードでの sandbox エラーに困っている人。

---

## 1. 導入 — Segmentation Fault の正体

Linux で Electron アプリを起動したら、いきなりこうなった。

```
$ ./MyApp-1.0.0-x64.AppImage
Segmentation fault (core dumped)
```

あるいは、もう少し親切なエラーが出ることもある。

```
The SUID sandbox helper binary was found, but is not configured correctly.
Rather than run without sandboxing I'm aborting now.
You need to make sure that /path/to/chrome-sandbox is owned by root and has mode 4755.
```

原因は **Chromium の sandbox 機構**だ。Electron は内部に Chromium を抱えており、Chromium が Linux 上でプロセスを sandbox 化するために必要な権限が足りないと、起動すらできない。

本記事では、この問題の仕組みと、パッケージ形式ごとの対策を解説する。

---

## 2. Chromium sandbox とは

### sandbox の目的

Chromium（= Chrome のオープンソース基盤）は、レンダラープロセスを **sandbox** で隔離する。Web ページが悪意あるコードを実行しても、OS のファイルシステムやプロセスに直接アクセスできないようにするためだ。

これはブラウザとして極めて重要なセキュリティ機構であり、Electron もこの仕組みをそのまま継承している。

### Linux で問題になる理由

Windows や macOS では、OS が提供するサンドボックス API（Win32 の Job Object や macOS の App Sandbox）を使える。しかし Linux にはブラウザ向けの統一的な sandbox API が存在しない。

そこで Chromium は Linux 上で **2つのサンドボックス方式** を用意している:

| 方式 | 仕組み | 必要な条件 |
|------|--------|-----------|
| **Namespace sandbox** | Linux カーネルの unprivileged user namespaces を利用 | カーネルが `unprivileged_userns_clone` を許可していること |
| **SUID sandbox** | `chrome-sandbox` という SUID ビット付きバイナリを利用 | `chrome-sandbox` が root 所有で mode 4755 であること |

Chromium はまず namespace sandbox を試み、使えなければ SUID sandbox にフォールバックする。**どちらも使えない場合、アプリはクラッシュする。**

### Namespace sandbox が使えないケース

Ubuntu 24.04 では、AppArmor がデフォルトで unprivileged user namespaces を制限するようになった。これは namespace sandbox を悪用する攻撃（カーネルの攻撃面が増える問題）への対策だが、結果として Electron アプリが namespace sandbox を使えなくなるケースが出てきている。

参考: [Chromium Docs - AppArmor User Namespace Restrictions](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md)

---

## 3. SUID sandbox の仕組み

### chrome-sandbox バイナリとは

Electron のディストリビューションには `chrome-sandbox` というバイナリが含まれている。
開発環境では以下の場所にある:

```
node_modules/electron/dist/chrome-sandbox
```

パッケージ後のアプリでは:

```
/opt/MyApp/chrome-sandbox       # .deb の場合
./resources/chrome-sandbox      # AppImage 内部
```

### SUID ビットとは

SUID（Set User ID）は Unix の権限ビットの一つで、**実行時にファイルの所有者の権限で動作する** ことを意味する。

```bash
# 通常のバイナリ
-rwxr-xr-x 1 user user 12345 chrome-sandbox

# SUID ビットが設定されたバイナリ
-rwsr-xr-x 1 root root 12345 chrome-sandbox
```

`chrome-sandbox` に SUID ビットを設定すると、一般ユーザーが実行しても **root 権限で起動** する。これにより、sandbox の設定に必要な特権操作（chroot、setuid など）を実行できるようになる。

### 設定方法

```bash
sudo chown root:root /path/to/chrome-sandbox
sudo chmod 4755 /path/to/chrome-sandbox
```

`4755` の意味:
- `4` = SUID ビット
- `7` = 所有者に rwx（読み・書き・実行）
- `5` = グループに r-x（読み・実行）
- `5` = その他に r-x（読み・実行）

### なぜ開発モードで問題になるか

`node_modules/electron/dist/chrome-sandbox` は npm/pnpm でインストールされるため、所有者は一般ユーザーであり SUID ビットも設定されていない。手動で設定することもできるが、`node_modules` を再インストールするたびにリセットされる。

そのため、**開発時には sandbox を無効化するのが現実的な選択** になる。

---

## 4. パッケージ形式ごとの対策

### 4.1 .deb パッケージ — SUID ビットで sandbox 有効

`.deb` パッケージは `sudo dpkg -i` でインストールするため、root 権限でファイルを配置できる。`electron-installer-debian` は、生成する `.deb` の中で `chrome-sandbox` に適切な権限を設定する。

```
# .deb パッケージ内の chrome-sandbox
-rwsr-xr-x 1 root root  chrome-sandbox
```

**結果:** sandbox が正常に動作する。`ELECTRON_DISABLE_SANDBOX` は不要。

```bash
# .deb インストール後の起動（特別な設定は不要）
Amical
```

これが最もセキュアな配布方法だ。

### 4.2 AppImage — `--no-sandbox` フラグ自動付与

AppImage は単一の実行可能ファイルで、sudo 不要で動作する。つまり SUID ビットを設定する手段がない。

[electron-builder の PR #4496](https://github.com/electron-userland/electron-builder/pull/4496) により、**Electron v5 以降の AppImage では `--no-sandbox` フラグがデフォルトで付与される** ようになった（electron-builder v22.10.3 以降）。

これにより、ユーザーが何も意識しなくても AppImage は起動する。ただし sandbox は無効な状態で動作している。

```bash
# AppImage の起動（内部で --no-sandbox が自動付与される）
chmod +x ./Amical-1.1.0-x64.AppImage
./Amical-1.1.0-x64.AppImage
```

`@reforged/maker-appimage`（Electron Forge 向けの AppImage Maker）を使う場合も同様の挙動になる。

> **補足:** `--no-sandbox` が自動付与されない古いバージョンの場合、冒頭に書いた Segmentation Fault が発生する。

### 4.3 開発モード (pnpm start) — 環境変数で sandbox 無効化

開発中は `node_modules` 内の Electron を直接使うため、`chrome-sandbox` に SUID ビットが設定されていない。

```bash
# これは失敗する
pnpm start
# → The SUID sandbox helper binary was found, but is not configured correctly.

# 環境変数で sandbox を無効化する
ELECTRON_DISABLE_SANDBOX=1 pnpm start
```

`ELECTRON_DISABLE_SANDBOX=1` を設定すると、Electron は内部的に `--no-sandbox` フラグを付与してアプリを起動する。

便利なようにラッパースクリプトを用意しておくとよい:

```bash
#!/bin/bash
# run.sh
ELECTRON_DISABLE_SANDBOX=1 pnpm start "$@"
```

### 4.4 対策の早見表

| パッケージ形式 | sandbox の状態 | 必要な対策 | sudo |
|--------------|---------------|-----------|------|
| `.deb` | **有効** (SUID) | なし | 必要 |
| AppImage | 無効 (`--no-sandbox` 自動) | なし | 不要 |
| tar.gz (手動展開) | **動作しない** | 手動で `--no-sandbox` を指定 | 不要 |
| 開発モード | **動作しない** | `ELECTRON_DISABLE_SANDBOX=1` | 不要 |

---

## 5. VS Code の事例 — Microsoft も同じ問題に直面している

「sandbox の問題なんて、自分のアプリの設定が悪いんじゃないか」と思うかもしれない。しかし、**世界で最も広く使われている Electron アプリである VS Code も、まったく同じ問題に対処してきた。**

### VS Code の対応の歴史

1. **Electron 6 移行時 (2019年):** Electron 6 で sandbox がデフォルト有効になった際、VS Code のビルドスクリプト全体に `--no-sandbox` を設定する [PR #81096](https://github.com/microsoft/vscode/pull/81096) がマージされた。

2. **tar.gz 配布:** VS Code の tar.gz 版（ユーザーインストール）では、`chrome-sandbox` に SUID ビットを設定できないため、起動スクリプトが `--no-sandbox` を付与する形で配布されていた。

3. **sandbox 移行ブログ (2022年):** VS Code チームは [Migrating VS Code to Process Sandboxing](https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox) というブログ記事を公開し、レンダラープロセスからの Node.js 依存を段階的に除去する取り組みを説明した。sandbox を有効にするために、数年かけてアーキテクチャを変更した。

4. **現在:** `.deb` や `.rpm` パッケージでは sandbox が有効な状態で配布されているが、コンテナ内やユーザーインストールでは依然として `--no-sandbox` が必要なケースがある。

### VS Code からの教訓

- **sandbox の問題は Electron アプリ共通の課題であり、アプリ固有の問題ではない**
- Microsoft ほどのリソースがあっても、sandbox 対応には数年かかった
- パッケージ形式ごとに異なる対策が必要なのは、Linux のセキュリティモデルに起因する構造的な問題

参考:
- [VS Code Issue #81056 - VSCode not starting unless --no-sandbox provided](https://github.com/microsoft/vscode/issues/81056)
- [VS Code Issue #76963 - Linux tests require --no-sandbox](https://github.com/microsoft/vscode/issues/76963)
- [Electron Issue #18265 - Need a way to run with --no-sandbox by default](https://github.com/electron/electron/issues/18265)

---

## 6. セキュリティへの影響

### sandbox を無効にするリスク

sandbox を無効にすると、レンダラープロセスが OS のリソースに直接アクセスできるようになる。具体的には:

- ファイルシステムへの制限なしのアクセス
- ネットワーク通信の制限解除
- プロセス間通信の制限解除

**ブラウザの場合、これは致命的** だ。ユーザーが訪問する任意の Web サイトのコードが、ローカルファイルを読み取れてしまう。

### デスクトップアプリでの現実的な判断

しかし、**デスクトップ Electron アプリの場合、状況はブラウザとは異なる:**

1. **信頼されたコードのみが実行される:** デスクトップアプリは開発者が書いたコードを実行する。任意の Web サイトを開くブラウザとは異なり、レンダラープロセスで実行されるコードは基本的に信頼されている。

2. **Node.js integration:** 多くの Electron アプリは `nodeIntegration: true` や `preload` スクリプトを通じて、レンダラーからシステムリソースにアクセスしている。sandbox を有効にしても、IPC を通じて同等のアクセスが可能なことが多い。

3. **攻撃ベクトルが限定的:** デスクトップアプリの攻撃は通常、悪意あるファイルを開かせるか、アプリ内の XSS 脆弱性を突くことで発生する。アプリが外部コンテンツを表示しない場合、リスクは限定的。

### 推奨されるアプローチ

| 状況 | 推奨 |
|------|------|
| `.deb` / `.rpm` で配布 | sandbox **有効** (SUID ビット設定) |
| AppImage で配布 | `--no-sandbox` で sandbox 無効（仕方ない） |
| 開発中 | `ELECTRON_DISABLE_SANDBOX=1` で sandbox 無効 |
| 外部 Web コンテンツを表示するアプリ | sandbox 有効を強く推奨 |
| 社内ツール・限定配布 | sandbox 無効でも許容範囲 |

**重要:** sandbox を無効にする場合でも、`contextIsolation: true` と `nodeIntegration: false` は維持すべきだ。これらは sandbox とは別のセキュリティ層であり、レンダラープロセスからメインプロセスへの不正アクセスを防ぐ。

---

## 7. 実装の詳細

### 7.1 forge.config.ts での MakerDeb 設定

`electron-forge` で `.deb` パッケージをビルドする場合、`MakerDeb` の設定で依存パッケージを指定する:

```typescript
// forge.config.ts
new MakerDeb({
  options: {
    bin: "Amical",
    name: "amical",
    productName: "Amical",
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
    icon: "./assets/logo.png",
  },
}),
```

`electron-installer-debian` が `.deb` を生成する際に、`chrome-sandbox` に SUID ビットを自動設定してくれる。開発者が明示的に何かする必要はない。

### 7.2 MakerAppImage の設定

```typescript
// forge.config.ts
import { MakerAppImage } from "@reforged/maker-appimage";

new MakerAppImage({
  options: {
    bin: "Amical",
    name: "Amical",
    icon: "./assets/logo.png",
    categories: ["Utility", "Audio"],
    genericName: "Dictation App",
  },
}),
```

AppImage 内部では `--no-sandbox` が自動付与されるため、sandbox に関する追加設定は不要。

### 7.3 package.json のスクリプト

```json
{
  "scripts": {
    "start": "electron-forge start",
    "make:linux": "pnpm build:deps && pnpm build:linux-helper && SKIP_RPM=true electron-forge make --platform=linux --arch=x64"
  }
}
```

開発時の起動:

```bash
ELECTRON_DISABLE_SANDBOX=1 pnpm start
```

### 7.4 postPackage フックの活用（参考）

現時点で Linux 向けの `postPackage` フック処理はないが、必要になった場合はここで `chrome-sandbox` のパーミッション設定などを行うことができる:

```typescript
// forge.config.ts
postPackage: async (_forgeConfig, options) => {
  const { outputPaths, platform } = options;

  if (platform === "linux") {
    for (const outputPath of outputPaths) {
      const sandboxPath = join(outputPath, "chrome-sandbox");
      // .deb の場合は electron-installer-debian が SUID を設定するため、
      // ここでの設定は通常不要。
      // tar.gz 配布の場合にのみ検討。
      console.log(`[postPackage] chrome-sandbox at: ${sandboxPath}`);
    }
  }
},
```

---

## 8. まとめ

### パッケージ形式ごとの sandbox 対策早見表

| | .deb | AppImage | tar.gz | 開発モード |
|---|---|---|---|---|
| **インストール権限** | root (sudo) | 一般ユーザー | 一般ユーザー | 一般ユーザー |
| **sandbox** | 有効 (SUID) | 無効 (自動) | 要手動対応 | 無効 (環境変数) |
| **SUID ビット** | 自動設定 | N/A | 手動設定可 | 未設定 |
| **追加設定** | 不要 | 不要 | `--no-sandbox` | `ELECTRON_DISABLE_SANDBOX=1` |
| **セキュリティ** | 最も安全 | 許容範囲 | 設定次第 | 開発限定 |

### 要点

1. **sandbox エラーは Electron アプリ共通の Linux 固有問題。** Windows/macOS では発生しない。
2. **`.deb` パッケージが最もセキュア。** `chrome-sandbox` に SUID ビットが自動設定される。
3. **AppImage は `--no-sandbox` で sandbox を無効化して動作する。** sudo 不要と引き換えのトレードオフ。
4. **開発時は `ELECTRON_DISABLE_SANDBOX=1` が必要。** `node_modules` 内の `chrome-sandbox` には SUID ビットがないため。
5. **VS Code も同じ問題に対処してきた。** これは Electron フレームワークの構造的な課題であり、個別アプリの問題ではない。

### 参考リンク

- [Chromium Linux Sandboxing](https://chromium.googlesource.com/chromium/src/+/b4730a0c2773d8f6728946013eb812c6d3975bec/docs/linux_sandboxing.md)
- [Chromium Linux SUID Sandbox](https://chromium.googlesource.com/chromium/src/+/main/docs/linux/suid_sandbox_development.md)
- [Electron Issue #17972 - SUID sandbox helper binary](https://github.com/electron/electron/issues/17972)
- [Electron Issue #18265 - Need a way to run with --no-sandbox by default](https://github.com/electron/electron/issues/18265)
- [electron-builder PR #4496 - Add default --no-sandbox for AppImage](https://github.com/electron-userland/electron-builder/pull/4496)
- [VS Code - Migrating to Process Sandboxing](https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox)
- [VS Code PR #81096 - set no-sandbox everywhere](https://github.com/microsoft/vscode/pull/81096)
- [AppImage Electron Sandboxing Troubleshooting](https://docs.appimage.org/user-guide/troubleshooting/electron-sandboxing.html)
