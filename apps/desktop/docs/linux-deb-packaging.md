# Linux Package Build Guide (.deb / AppImage)

---

> **TL;DR -- Frequently Used Commands**
>
> | Task | Command |
> |------|---------|
> | Development launch | `ELECTRON_DISABLE_SANDBOX=1 pnpm start` (or `./run.sh`) |
> | Package build | `cd apps/desktop && pnpm make:linux` |
> | First time only | `pnpm download-node && convert assets/logo.svg -resize 256x256 assets/logo.png` |
>
> **Important:** Do not use the `--targets` flag with `electron-forge make`.  
> Custom settings from `forge.config.ts` will be ignored and the build will fail ([details](#23-problem-3-maker-settings-ignored-when-using---targets-flag)).

---

## Overview

This document covers the build procedure for Amical Desktop's Ubuntu/Debian distribution packages,
along with issues discovered during build environment setup and their solutions.

Two package formats are supported:

| Format | File | Installation Method | sudo | Use Case |
|--------|------|---------------------|------|----------|
| `.deb` | `amical_1.1.0_amd64.deb` | `dpkg -i` | Required | System installation |
| AppImage | `Amical-1.1.0-x64.AppImage` | Set execute permission and run | Not required | User installation (portable) |

---

## 1. Build Procedure

> **Build on Ubuntu 24.04 for both 24.04 and 26.04.**
> A package built on 24.04 (glibc 2.39) runs on both 24.04 and 26.04 thanks to
> glibc forward compatibility, so a single package covers both releases. A package
> built on 26.04 links against a newer glibc and will **fail to start on 24.04**.
> ydotool's v0.1.x (24.04) and v1.x (26.04) differences are already handled at
> runtime in `linux-helper-ts/src/handlers/paste-text.ts`, so no separate package
> is needed for the paste behavior.

### 1.1 Prerequisites

- Ubuntu 24.04 LTS (amd64)
- Node.js v22.x
- pnpm 10.x
- Required system packages:

```bash
sudo apt install dpkg fakeroot imagemagick
```

### 1.2 Common Preparation (First Time Only)

```bash
cd apps/desktop

# Node.js バイナリのダウンロード
pnpm download-node

# アイコン用 PNG の生成（logo.png が存在しない場合）
convert assets/logo.svg -resize 256x256 assets/logo.png
```

### 1.3 Building Packages

The following command builds both `.deb` and AppImage simultaneously:

```bash
cd apps/desktop
pnpm make:linux
```

Internally, this executes `pnpm build:deps && pnpm build:linux-helper && SKIP_RPM=true electron-forge make --platform=linux --arch=x64`.

### 1.4 Output Location

```
apps/desktop/out/make/deb/x64/amical_1.1.0_amd64.deb        # 143 MB
apps/desktop/out/make/AppImage/x64/Amical-1.1.0-x64.AppImage # 196 MB
```

### 1.5 Installation Methods

#### .deb Package (System Installation)

```bash
sudo dpkg -i out/make/deb/x64/amical_1.1.0_amd64.deb
sudo apt-get install -f   # 不足する依存パッケージがあれば自動インストール
```

- Launch from the application menu or via the `Amical` command
- **`ELECTRON_DISABLE_SANDBOX=1`, which was needed during development, is not required**
  (The `.deb` package correctly sets the SUID bit on `chrome-sandbox`)
- To uninstall: `sudo apt remove amical`

#### AppImage (User Installation)

```bash
# 任意の場所にコピー（例: ~/Applications/）
mkdir -p ~/Applications
cp out/make/AppImage/x64/Amical-1.1.0-x64.AppImage ~/Applications/

# 実行権限を付与して起動
chmod +x ~/Applications/Amical-1.1.0-x64.AppImage
~/Applications/Amical-1.1.0-x64.AppImage
```

- No sudo required. A single-file, self-contained portable format
- To uninstall, simply delete the file
- The `--no-sandbox` flag is automatically included, so no additional configuration is needed
- If desktop integration (menu registration, etc.) is needed,
  [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher) is recommended

### 1.6 Building via pnpm Scripts

You can also build using the scripts defined in `package.json`,
but it will also attempt to build RPM, which requires `rpmbuild`:

```bash
# RPM も含めてビルドする場合（要 rpmbuild: sudo apt install rpm）
pnpm make:linux

# RPM をスキップして .deb + AppImage のみビルドする場合
SKIP_RPM=true pnpm exec electron-forge make --platform=linux --arch=x64
```

---

## 2. Investigation History and Resolved Issues

### 2.1 Problem 1: rpmbuild Not Found

**Symptom:**
Running `pnpm make:linux` fails with the following error:

```
Cannot make for rpm, the following external binaries need to be installed: rpmbuild
```

**Cause:**
The `makers` array in `forge.config.ts` includes `MakerRpm`,
and the entire build fails if the `rpmbuild` command is not present.

**Solution:**
Made `MakerRpm` conditional on the `SKIP_RPM` environment variable in `forge.config.ts`:

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

### 2.2 Problem 2: Node.js Binary Not Found

**Symptom:**
The prePackage hook in `electron-forge make` throws the following error:

```
✗ Node.js binary not found for linux-x64
  Please run 'pnpm download-node' or 'pnpm download-node:all' first
```

**Cause:**
Amical uses Node.js as a child process separately from the main process (for Whisper workers, etc.),
and platform-specific Node.js binaries must be bundled in the `node-binaries/` directory.

**Solution:**

```bash
pnpm download-node
```

This downloads the binary to `apps/desktop/node-binaries/linux-x64/node`.

---

### 2.3 Problem 3: Maker Settings Ignored When Using `--targets` Flag

**Symptom:**
When building with `--targets=@electron-forge/maker-deb`,
all options configured in `forge.config.ts` such as `bin`, `name`, etc. are ignored,
resulting in the following error:

```
could not find the Electron app binary at
"/.../out/Amical-linux-x64/@amical/desktop"
```

The binary name should be `Amical`, but `package.json`'s `name` (`@amical/desktop`) is used instead.

**Cause:**
The behavior of the `generateTargets` function in `electron-forge`'s `make.js`:

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

The name passed via `--targets=@electron-forge/maker-deb` is the NPM package name,
but `forgeConfig.makers.find()` compares against `maker.name` (= `'deb'`).
Since the names do not match, **a new MakerDeb instance with no configuration is created.**

Without configuration, the default value generation logic in `electron-installer-common` produces:

```javascript
// node_modules/electron-installer-common/src/defaults.js (15行目)
bin: pkg.name || 'electron',  // → '@amical/desktop'
```

The `name` field from `package.json` inside the ASAR is used as the binary name.

**Debugging process:**

1. Added debug logs to `electron-installer-debian` and `MakerDeb`
2. Confirmed that both `this.config` and `this.configOrConfigFetcher` were `{}`
3. Verified the `_.defaults()` merge order and identified the empty config as the root cause
4. Discovered the name matching logic in `generateTargets`

**Solution:**
Do not use the `--targets` flag. Instead, conditionally exclude unwanted Makers from `forge.config.ts`
and run `electron-forge make`.

---

### 2.4 Problem 4: PNG Icon Does Not Exist

**Symptom:**
```
The icon "./assets/logo.png" does not exist
```

**Cause:**
The `MakerDeb` configuration specifies `icon: "./assets/logo.png"`,
but the repository only contains `.icns`, `.ico`, and `.svg` files -- no PNG.

**Solution:**
Generate a PNG from SVG using ImageMagick:

```bash
convert assets/logo.svg -resize 256x256 assets/logo.png
```

> Note: ImageMagick's SVG rendering is limited,
> so it is recommended to create the official icon separately using a design tool.

---

## 3. Changes to forge.config.ts

### MakerDeb Configuration Added

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

`bin: "Amical"` is the most critical setting.
Without it, `package.json`'s `name` (`@amical/desktop`) is used as the binary name,
and the installer fails because it cannot find the packaged binary.

### MakerAppImage Added

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

- Uses the community package `@reforged/maker-appimage`
  (no official `@electron-forge/maker-appimage` exists)
- Already added to `devDependencies`

### Conditional MakerRpm Loading

```typescript
...(process.env.SKIP_RPM !== "true"
  ? [new MakerRpm({ ... })]
  : []),
```

---

## 4. Generated Package Information

### .deb Package

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
Filename: Amical-1.1.0-x64.AppImage
Size: 196 MB
Format: ELF 64-bit, static-pie linked
Target: x86-64 Linux
```

AppImage is larger than `.deb` because it bundles all dependency libraries.

---

## 5. Comparison: .deb vs AppImage

| Aspect | .deb | AppImage |
|--------|------|----------|
| Installation | `sudo dpkg -i` | Place file and `chmod +x` |
| Root privileges | Required | Not required |
| Uninstallation | `sudo apt remove amical` | Delete the file |
| Desktop integration | Automatic (menu, icons) | Manual or via AppImageLauncher |
| Sandbox | Enabled via SUID | Runs with `--no-sandbox` |
| Auto-updates | Via apt (when repository is registered) | Not supported (manual replacement) |
| Distribution size | 143 MB | 196 MB |
| Dependencies | Managed by apt | All bundled |

**Recommendations:**
- Installing on your own PC -> `.deb`
- Sharing with others or carrying on USB -> AppImage

---

## 6. Known Caveats

- Using the `--targets` flag causes custom settings in `forge.config.ts` to be ignored
  (known Electron Forge behavior: the `name` property in the makers array
  does not match the NPM package name passed via `--targets`)
- Building RPM packages requires `rpmbuild` (`sudo apt install rpm`)
- PNG icons are not included in the repository and must be generated before building
- The sandbox is automatically enabled when installed via `.deb`
  (the SUID bit is set on `chrome-sandbox`)
- AppImage uses `@reforged/maker-appimage` (a community package)
