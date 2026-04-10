# Building .deb and AppImage Simultaneously with Electron Forge -- A Practical Guide to Linux Packaging

## Introduction

When distributing an Electron app for Linux, offering both `.deb` (for Debian/Ubuntu-based systems) and AppImage (a distro-independent portable format) gives users more choices.

This article explains how to use **Electron Forge** to build both formats with a single command, based on the configuration of a real project (Amical Desktop -- an AI-powered voice input app). We also cover pitfalls specific to monorepo setups with native modules and their solutions.

### Technology Stack

| Component | Version/Tool |
|-----------|-------------|
| Electron | 38.x |
| Electron Forge | 7.8.2 |
| Build Tool | Vite (via VitePlugin) |
| Package Manager | pnpm 10.x |
| Node.js | 22.x |
| Target OS | Ubuntu 24.04 LTS (amd64) |

---

## Build Pipeline

The package build is executed with a single command: `pnpm make:linux`. Internally, it runs a three-stage pipeline.

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

### package.json Script Definitions

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

`build:native-helper` does nothing on Linux (it prints `No native helpers` and exits). Instead, `build:linux-helper` builds the Linux-specific native helper. This two-step approach exists because `linux-helper-ts` is managed as an independent npm project rather than a monorepo workspace package.

---

## Electron Forge Configuration

`forge.config.ts` is the main configuration file. Let's walk through its key components.

### Makers (Package Format Definitions)

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

All platform Makers coexist in a single array. When you run `electron-forge make --platform=linux`, only the Linux-compatible Makers are automatically selected.

### Plugins (Vite + Fuses)

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

The `FusesPlugin` bakes Electron security settings at the binary level during packaging. `RunAsNode: false` disables the `ELECTRON_RUN_AS_NODE` environment variable to prevent misuse of distributed binaries.

---

## The SKIP_RPM Flag: Background

### The Problem

`electron-forge make` executes all Makers in the `makers` array in sequence. When `MakerRpm` is included, it checks for the `rpmbuild` command. On Ubuntu where it is not installed, the entire build fails immediately.

```
Cannot make for rpm, the following external binaries need to be installed: rpmbuild
```

Building RPMs on Ubuntu is uncommon, so installing `rpmbuild` via `sudo apt install rpm` adds unnecessary overhead.

### Solution: Conditional Branching via Environment Variable

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

By embedding `SKIP_RPM=true` in the `make:linux` script in `package.json`, RPM builds are skipped by default on Ubuntu.

```jsonc
"make:linux": "pnpm build:deps && pnpm build:linux-helper && SKIP_RPM=true electron-forge make --platform=linux --arch=x64"
```

> **Note:** The check uses `!== "true"`, meaning **RPM will be built if the environment variable is not set**. This is the correct default behavior for CI/CD pipelines that also distribute for Fedora/RHEL.

---

## prePackage Hook -- Critical Pre-Build Processing

The `hooks.prePackage` in `forge.config.ts` runs before Electron Forge packages the app. In this project, it handles several critical tasks.

### 1. Node.js Binary Existence Check

```typescript
prePackage: async (_forgeConfig, platform, arch) => {
  const nodeBinarySource = join(projectRoot, "node-binaries", `${platform}-${arch}`, "node");
  if (!existsSync(nodeBinarySource)) {
    throw new Error(`Missing Node.js binary for ${platform}-${arch}`);
  }
}
```

Amical launches child processes such as Whisper workers, so platform-specific Node.js binaries must be bundled. Download them in advance with `pnpm download-node`.

### 2. Monorepo Dependency Resolution

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

In a monorepo, `node_modules` are hoisted to the root, so Electron Forge's default module resolution cannot find them. Using `flora-colossus` (an internal dependency of Electron Forge), nested dependencies for each module are recursively explored and copied to the local `node_modules`.

```typescript
// flora-colossus で依存ツリーを歩く
const walker = new Walker(monorepoRoot);
await walker.walkDependenciesForModule(moduleRoot, DepType.PROD);
```

### 3. Pruning Unnecessary Binaries

`onnxruntime-node` includes binaries for all platforms, which bloats the package size if left as-is. Binaries for non-target platforms are deleted.

```typescript
// 不要なプラットフォームのバイナリを削除
if (platformDir !== targetPlatform && platformDir !== "linux") {
  rmSync(platformPath, { recursive: true, force: true });
}
```

Similarly, the `whisper.cpp` source code and `build` directory from `@amical/whisper-wrapper` are also removed.

### 4. Materializing Symlinks

In a pnpm monorepo, workspace packages are placed as symlinks. Since ASAR packaging does not handle symlinks correctly, they are replaced with actual files.

```typescript
if (stats.isSymbolicLink()) {
  const symlinkTarget = readlinkSync(localDepPath);
  rmSync(localDepPath, { recursive: true, force: true });
  cpSync(sourcePath, localDepPath, { recursive: true, dereference: true });
}
```

---

## postPackage Hook

`postPackage` runs after packaging is complete. The current implementation bundles VC++ runtime DLLs for Windows.

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

There is currently no additional postPackage processing for Linux, but in `.deb` packages, the SUID bit is automatically set on `chrome-sandbox`, making `ELECTRON_DISABLE_SANDBOX=1` unnecessary after installation.

> **Note:** Since `packagerConfig` has `prune: false`, the `packageAfterPrune` hook is not executed. Empty directory cleanup logic remains in the code but is currently dead code.

---

## Building LinuxHelper

`build:linux-helper` is the script that builds the Linux-specific native helper process.

```jsonc
"build:linux-helper": "cd ../../packages/native-helpers/linux-helper-ts && npm run build"
```

### Role of LinuxHelper

LinuxHelper runs as an independent Node.js process and communicates with the Electron main process via JSON-RPC.

```
Electron (メインプロセス)  <--stdin/stdout JSON-RPC-->  LinuxHelper
```

Key features:

- **evdev keyboard monitoring** -- Reads directly from `/dev/input/event*` to detect global shortcuts (compatible with both X11 and Wayland)
- **Accessibility operations** -- Keyboard input simulation and clipboard operations using `ydotool` and `wl-clipboard`

### Build Process

```jsonc
// packages/native-helpers/linux-helper-ts/package.json
{
  "scripts": {
    "build": "tsc && chmod +x bin/LinuxHelper"
  }
}
```

TypeScript is compiled, and execute permission is granted to the entry point script `bin/LinuxHelper`. The build output is bundled into the package via `extraResource`.

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

## AppImage-Specific Configuration

AppImage generation uses the community package `@reforged/maker-appimage`. No official `@electron-forge/maker-appimage` exists.

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

### Key Points

- **`bin: "Amical"` is required.** Omitting it causes `package.json`'s `name` (`@amical/desktop`) to be used as the binary name, resulting in an error when the binary cannot be found in the package
- AppImage automatically includes the `--no-sandbox` flag, so SUID configuration is unnecessary
- Since all dependency libraries are bundled, AppImage is larger than `.deb` (approximately 196MB vs 143MB)

### Installation

```bash
chmod +x Amical-1.1.0-x64.AppImage
./Amical-1.1.0-x64.AppImage
```

No sudo required. To uninstall, simply delete the file.

---

## deb Package-Specific Configuration

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

### Option Descriptions

| Option | Description |
|--------|-------------|
| `bin` | Executable binary name within the package. Must match `packagerConfig.executableName` |
| `name` | Debian package name. The name shown by `dpkg -l`. Must be lowercase only |
| `depends` | Libraries that `dpkg` checks as package dependencies |
| `recommends` | Recommended packages for installation (e.g., clipboard tools for Wayland environments) |
| `mimeType` | Custom URL scheme (`amical://`) registration |

### The `--targets` Flag Pitfall

When specifying `--targets` like `electron-forge make --targets=@electron-forge/maker-deb`, **custom settings from `forge.config.ts` are ignored.**

The cause lies in Electron Forge's internal `generateTargets` function.

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

The name passed to `--targets` is the NPM package name (`@electron-forge/maker-deb`), but `makers.find()` compares against `maker.name` (= `'deb'`). Since the names do not match, **a new Maker with empty configuration is created.**

**Workaround: Do not use the `--targets` flag.** Exclude unwanted Makers using environment variables like `SKIP_RPM`.

---

## Execution Summary

### During Development

```bash
# 方法1: run.sh を使用
./run.sh

# 方法2: 直接実行
cd apps/desktop && ELECTRON_DISABLE_SANDBOX=1 pnpm start
```

`ELECTRON_DISABLE_SANDBOX=1` is only needed during development because the SUID bit is not set on `chrome-sandbox`.

### Package Build (Without Distribution Packages)

```bash
cd apps/desktop && pnpm package:linux
```

The packaged app is output to `out/Amical-linux-x64/`. Since Makers are not executed, no `.deb` or AppImage files are generated. This is for verification purposes.

### Generating Distribution Packages

```bash
cd apps/desktop && pnpm make:linux
```

Output location:

```
out/make/deb/x64/amical_1.1.0_amd64.deb        # ~143 MB
out/make/AppImage/x64/Amical-1.1.0-x64.AppImage # ~196 MB
```

### First-Time Setup (Prerequisites)

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

## Troubleshooting

### `rpmbuild` Not Found

```
Cannot make for rpm, the following external binaries need to be installed: rpmbuild
```

Build with `SKIP_RPM=true`. This flag is set by default in `pnpm make:linux`.

```bash
SKIP_RPM=true electron-forge make --platform=linux --arch=x64
```

### Node.js Binary Not Found

```
Node.js binary not found for linux-x64
```

```bash
pnpm download-node
```

### PNG Icon Does Not Exist

```
The icon "./assets/logo.png" does not exist
```

```bash
convert assets/logo.svg -resize 256x256 assets/logo.png
```

### Binary Not Found When Using `--targets`

```
could not find the Electron app binary at ".../out/Amical-linux-x64/@amical/desktop"
```

Do not use the `--targets` flag. It causes the Maker settings in `forge.config.ts` to be ignored, and `package.json`'s `name` (`@amical/desktop`) is used as the binary name instead.

### Sandbox Error (During Development)

```
The SUID sandbox helper binary was found, but is not configured correctly.
```

```bash
ELECTRON_DISABLE_SANDBOX=1 pnpm start
```

When installed via `.deb`, the SUID bit is automatically set on `chrome-sandbox`, so this issue does not occur.

### Native Module Not Found in Monorepo

`packagerConfig.prune` is set to `false`, and the `packagerConfig.ignore` function uses a whitelist approach to include only the required modules. When adding new native modules, they must be added to the `EXTERNAL_DEPENDENCIES` array.

```typescript
export const EXTERNAL_DEPENDENCIES = [
  "new-native-module",  // ここに追加
  // ...
];
```

---

## Summary

Key points for building `.deb` and AppImage simultaneously for Linux with Electron Forge:

1. **Always set the `bin` option.** Omitting it causes `package.json`'s `name` to be used as the binary name. For scoped package names (`@scope/name`), the path will break
2. **Do not use the `--targets` flag.** There is a known Electron Forge behavior where Maker settings are ignored. Exclude unwanted Makers using environment variables
3. **Skip RPM builds with `SKIP_RPM=true`.** This eliminates the need to install `rpmbuild` on Ubuntu
4. **Dependency resolution requires extra work in monorepos.** Use `flora-colossus` to recursively explore nested dependencies and materialize symlinks
5. **Use `@reforged/maker-appimage` for AppImage.** No official Maker exists, so a community package is needed
6. **`ELECTRON_DISABLE_SANDBOX=1` is required during development.** It is not needed after `.deb` installation

These insights should serve as a useful reference when tackling Linux packaging with Electron Forge + monorepo + native modules.
