# Understanding the Sandbox Issue in Electron Apps --- Why ELECTRON_DISABLE_SANDBOX Is Needed and Solutions for Each Package Format

---

> **Target audience:** Developers building and distributing Electron apps on Linux. Particularly those encountering sandbox errors with `.deb`, AppImage, or development mode.

---

## 1. Introduction --- The Real Cause of Segmentation Faults

You launch your Electron app on Linux, and it immediately crashes.

```
$ ./MyApp-1.0.0-x64.AppImage
Segmentation fault (core dumped)
```

Or sometimes you get a slightly more helpful error message.

```
The SUID sandbox helper binary was found, but is not configured correctly.
Rather than run without sandboxing I'm aborting now.
You need to make sure that /path/to/chrome-sandbox is owned by root and has mode 4755.
```

The cause is **Chromium's sandbox mechanism**. Electron embeds Chromium internally, and if Chromium lacks the permissions required to sandbox processes on Linux, the app cannot even start.

This article explains the mechanics of this issue and solutions for each package format.

---

## 2. What Is the Chromium Sandbox?

### Purpose of the Sandbox

Chromium (the open-source foundation of Chrome) isolates renderer processes using a **sandbox**. This prevents malicious code executed by web pages from directly accessing the OS's filesystem or processes.

This is an extremely important security mechanism for browsers, and Electron inherits this system as-is.

### Why It Becomes a Problem on Linux

On Windows and macOS, the OS provides sandbox APIs (Win32 Job Objects and macOS App Sandbox, respectively). However, Linux has no unified sandbox API designed for browsers.

To address this, Chromium provides **two sandbox mechanisms** on Linux:

| Method | Mechanism | Required Condition |
|------|--------|-----------|
| **Namespace sandbox** | Uses Linux kernel's unprivileged user namespaces | Kernel must allow `unprivileged_userns_clone` |
| **SUID sandbox** | Uses a `chrome-sandbox` binary with the SUID bit set | `chrome-sandbox` must be owned by root with mode 4755 |

Chromium first tries the namespace sandbox and falls back to the SUID sandbox if unavailable. **If neither is available, the app crashes.**

### Cases Where the Namespace Sandbox Is Unavailable

In Ubuntu 24.04, AppArmor restricts unprivileged user namespaces by default. This is a countermeasure against attacks that exploit namespace sandboxing (which increases the kernel's attack surface), but it results in cases where Electron apps can no longer use the namespace sandbox.

Reference: [Chromium Docs - AppArmor User Namespace Restrictions](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md)

---

## 3. How the SUID Sandbox Works

### The chrome-sandbox Binary

Electron's distribution includes a binary called `chrome-sandbox`.
In a development environment, it is located at:

```
node_modules/electron/dist/chrome-sandbox
```

In a packaged app:

```
/opt/MyApp/chrome-sandbox       # for .deb
./resources/chrome-sandbox      # inside AppImage
```

### What Is the SUID Bit?

SUID (Set User ID) is a Unix permission bit that means **the file runs with the permissions of its owner** when executed.

```bash
# Normal binary
-rwxr-xr-x 1 user user 12345 chrome-sandbox

# Binary with SUID bit set
-rwsr-xr-x 1 root root 12345 chrome-sandbox
```

When the SUID bit is set on `chrome-sandbox`, even when a regular user executes it, it **runs with root privileges**. This allows the privileged operations required for sandbox setup (chroot, setuid, etc.) to be performed.

### How to Configure

```bash
sudo chown root:root /path/to/chrome-sandbox
sudo chmod 4755 /path/to/chrome-sandbox
```

Meaning of `4755`:
- `4` = SUID bit
- `7` = Owner has rwx (read, write, execute)
- `5` = Group has r-x (read, execute)
- `5` = Others have r-x (read, execute)

### Why This Is a Problem in Development Mode

`node_modules/electron/dist/chrome-sandbox` is installed via npm/pnpm, so the owner is a regular user and the SUID bit is not set. While it can be set manually, it resets every time `node_modules` is reinstalled.

Therefore, **disabling the sandbox during development is the pragmatic choice**.

---

## 4. Solutions by Package Format

### 4.1 .deb Packages --- Sandbox Enabled via SUID Bit

`.deb` packages are installed with `sudo dpkg -i`, so files can be placed with root privileges. `electron-installer-debian` sets the appropriate permissions on `chrome-sandbox` in the generated `.deb`.

```
# chrome-sandbox inside the .deb package
-rwsr-xr-x 1 root root  chrome-sandbox
```

**Result:** The sandbox works correctly. `ELECTRON_DISABLE_SANDBOX` is not needed.

```bash
# Launching after .deb installation (no special configuration needed)
Amical
```

This is the most secure distribution method.

### 4.2 AppImage --- `--no-sandbox` Flag Automatically Applied

AppImage is a single executable file that runs without sudo. This means there is no way to set the SUID bit.

Thanks to [electron-builder PR #4496](https://github.com/electron-userland/electron-builder/pull/4496), **the `--no-sandbox` flag is applied by default for Electron v5+ AppImages** (electron-builder v22.10.3 and later).

This allows AppImages to launch without the user having to do anything. However, the sandbox is disabled.

```bash
# Launching the AppImage (--no-sandbox is automatically applied internally)
chmod +x ./Amical-1.1.0-x64.AppImage
./Amical-1.1.0-x64.AppImage
```

The same behavior applies when using `@reforged/maker-appimage` (AppImage Maker for Electron Forge).

> **Note:** With older versions that do not automatically apply `--no-sandbox`, the Segmentation Fault described at the beginning of this article will occur.

### 4.3 Development Mode (pnpm start) --- Disable Sandbox via Environment Variable

During development, the Electron binary in `node_modules` is used directly, so the SUID bit is not set on `chrome-sandbox`.

```bash
# This will fail
pnpm start
# → The SUID sandbox helper binary was found, but is not configured correctly.

# Disable sandbox via environment variable
ELECTRON_DISABLE_SANDBOX=1 pnpm start
```

Setting `ELECTRON_DISABLE_SANDBOX=1` causes Electron to internally apply the `--no-sandbox` flag when launching the app.

It is convenient to prepare a wrapper script:

```bash
#!/bin/bash
# run.sh
ELECTRON_DISABLE_SANDBOX=1 pnpm start "$@"
```

### 4.4 Quick Reference Table

| Package Format | Sandbox State | Required Action | sudo |
|--------------|---------------|-----------|------|
| `.deb` | **Enabled** (SUID) | None | Required |
| AppImage | Disabled (`--no-sandbox` auto) | None | Not required |
| tar.gz (manual extraction) | **Does not work** | Manually specify `--no-sandbox` | Not required |
| Development mode | **Does not work** | `ELECTRON_DISABLE_SANDBOX=1` | Not required |

---

## 5. The VS Code Case --- Microsoft Faced the Same Problem

You might think "the sandbox problem is just because my app's configuration is wrong." However, **VS Code, the most widely used Electron app in the world, has dealt with exactly the same problem.**

### VS Code's History of Addressing This

1. **Electron 6 migration (2019):** When Electron 6 made sandbox enabled by default, [PR #81096](https://github.com/microsoft/vscode/pull/81096) was merged to set `--no-sandbox` across VS Code's entire build scripts.

2. **tar.gz distribution:** For VS Code's tar.gz version (user install), the SUID bit cannot be set on `chrome-sandbox`, so the launch script was distributed with `--no-sandbox` applied.

3. **Sandbox migration blog (2022):** The VS Code team published [Migrating VS Code to Process Sandboxing](https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox), explaining their effort to incrementally remove Node.js dependencies from the renderer process. They changed the architecture over several years to enable the sandbox.

4. **Currently:** `.deb` and `.rpm` packages are distributed with sandbox enabled, but `--no-sandbox` is still required in containers and for user installs in some cases.

### Lessons from VS Code

- **The sandbox issue is a common Electron app challenge, not specific to any individual app**
- Even with Microsoft's resources, sandbox support took years
- The need for different solutions per package format is a structural issue stemming from Linux's security model

References:
- [VS Code Issue #81056 - VSCode not starting unless --no-sandbox provided](https://github.com/microsoft/vscode/issues/81056)
- [VS Code Issue #76963 - Linux tests require --no-sandbox](https://github.com/microsoft/vscode/issues/76963)
- [Electron Issue #18265 - Need a way to run with --no-sandbox by default](https://github.com/electron/electron/issues/18265)

---

## 6. Security Implications

### Risks of Disabling the Sandbox

Disabling the sandbox allows renderer processes to directly access OS resources. Specifically:

- Unrestricted access to the filesystem
- Removal of network communication restrictions
- Removal of inter-process communication restrictions

**For a browser, this is critical.** Code from any website the user visits could read local files.

### Pragmatic Considerations for Desktop Apps

However, **for desktop Electron apps, the situation differs from browsers:**

1. **Only trusted code is executed:** Desktop apps execute code written by the developer. Unlike browsers that open arbitrary websites, the code running in renderer processes is fundamentally trusted.

2. **Node.js integration:** Many Electron apps access system resources from the renderer through `nodeIntegration: true` or `preload` scripts. Even with sandbox enabled, equivalent access is often possible through IPC.

3. **Limited attack vectors:** Attacks on desktop apps typically involve tricking the user into opening a malicious file or exploiting XSS vulnerabilities within the app. If the app does not display external content, the risk is limited.

### Recommended Approach

| Situation | Recommendation |
|------|------|
| Distributing via `.deb` / `.rpm` | Sandbox **enabled** (SUID bit set) |
| Distributing via AppImage | Sandbox disabled with `--no-sandbox` (unavoidable) |
| During development | Sandbox disabled with `ELECTRON_DISABLE_SANDBOX=1` |
| Apps displaying external web content | Strongly recommend enabling sandbox |
| Internal tools / limited distribution | Disabling sandbox is acceptable |

**Important:** Even when disabling the sandbox, `contextIsolation: true` and `nodeIntegration: false` should be maintained. These are separate security layers from the sandbox that prevent unauthorized access from renderer processes to the main process.

---

## 7. Implementation Details

### 7.1 MakerDeb Configuration in forge.config.ts

When building `.deb` packages with `electron-forge`, dependency packages are specified in the `MakerDeb` configuration:

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

`electron-installer-debian` automatically sets the SUID bit on `chrome-sandbox` when generating the `.deb`. No explicit action is required from the developer.

### 7.2 MakerAppImage Configuration

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

Since `--no-sandbox` is automatically applied inside the AppImage, no additional sandbox-related configuration is needed.

### 7.3 package.json Scripts

```json
{
  "scripts": {
    "start": "electron-forge start",
    "make:linux": "pnpm build:deps && pnpm build:linux-helper && SKIP_RPM=true electron-forge make --platform=linux --arch=x64"
  }
}
```

Launching in development mode:

```bash
ELECTRON_DISABLE_SANDBOX=1 pnpm start
```

### 7.4 Using the postPackage Hook (Reference)

There is currently no `postPackage` hook processing for Linux, but if needed, it could be used to set `chrome-sandbox` permissions:

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

## 8. Summary

### Sandbox Solution Quick Reference by Package Format

| | .deb | AppImage | tar.gz | Development mode |
|---|---|---|---|---|
| **Install privileges** | root (sudo) | Regular user | Regular user | Regular user |
| **Sandbox** | Enabled (SUID) | Disabled (auto) | Manual setup required | Disabled (env var) |
| **SUID bit** | Auto-configured | N/A | Can be set manually | Not set |
| **Additional config** | None | None | `--no-sandbox` | `ELECTRON_DISABLE_SANDBOX=1` |
| **Security** | Most secure | Acceptable | Depends on config | Development only |

### Key Takeaways

1. **Sandbox errors are a Linux-specific issue common to all Electron apps.** They do not occur on Windows/macOS.
2. **`.deb` packages are the most secure.** The SUID bit is automatically set on `chrome-sandbox`.
3. **AppImage disables the sandbox with `--no-sandbox` to function.** This is a trade-off for not requiring sudo.
4. **`ELECTRON_DISABLE_SANDBOX=1` is needed during development.** The `chrome-sandbox` in `node_modules` does not have the SUID bit set.
5. **VS Code has dealt with the same problem.** This is a structural challenge of the Electron framework, not an issue with individual apps.

### References

- [Chromium Linux Sandboxing](https://chromium.googlesource.com/chromium/src/+/b4730a0c2773d8f6728946013eb812c6d3975bec/docs/linux_sandboxing.md)
- [Chromium Linux SUID Sandbox](https://chromium.googlesource.com/chromium/src/+/main/docs/linux/suid_sandbox_development.md)
- [Electron Issue #17972 - SUID sandbox helper binary](https://github.com/electron/electron/issues/17972)
- [Electron Issue #18265 - Need a way to run with --no-sandbox by default](https://github.com/electron/electron/issues/18265)
- [electron-builder PR #4496 - Add default --no-sandbox for AppImage](https://github.com/electron-userland/electron-builder/pull/4496)
- [VS Code - Migrating to Process Sandboxing](https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox)
- [VS Code PR #81096 - set no-sandbox everywhere](https://github.com/microsoft/vscode/pull/81096)
- [AppImage Electron Sandboxing Troubleshooting](https://docs.appimage.org/user-guide/troubleshooting/electron-sandboxing.html)
