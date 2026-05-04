# Project context for Claude Code

This file is loaded automatically into Claude Code conversations on any machine
that clones this fork. It captures portable project context (Linux porting
status, build/release workflow, known platform quirks) so work can continue
seamlessly across machines, distros, and desktop environments.

Personal preferences, collaboration style, and any sensitive research stay
machine-local under `~/.claude/projects/<project>/memory/` — do not move them
here.

---

## Linux porting status

Porting Amical Desktop to Linux. This fork (`tosihide/amical`) tracks the
upstream `amicalhq/amical` and adds Linux-specific support.

- Active branch: `ubuntu-26.04-lts` — targets Ubuntu 26.04 LTS only
- Predecessor: `develop_ubuntu` (24.04 series), released through `v1.1.0-linux.7`
- 26.04 series starts at `v1.1.0-linux.8` (2026-05-04)

### Known platform quirks (Linux)
- **whisper.cpp + OpenMP**: static `libgomp.a` lacks `-fPIC`, so building the
  shared `whisper.node` addon fails. Worked around with `GGML_OPENMP=OFF`
  (`packages/whisper-wrapper/addon/CMakeLists.txt`).
- **evdev keyboard monitor**: requires the user to be in the `input` group.
  The helper detects missing membership and prints a fix command to stderr.
- **Wayland keymap**: `setxkbmap -query` does not return options on Wayland.
  Use `gsettings` instead, and `gsettings monitor` to detect runtime changes.
- **GNOME Dock icon**: Wayland matches `app_id` against `.desktop` filenames.
  Set Electron WM class to `amical` (`main.ts`) and ship a custom
  `desktop.ejs` with `StartupWMClass=amical` (commits `f025ac1`, `8f89dbf`).
- **ydotool 1.x** (Ubuntu 26.04 default, package version 1.0.4):
  - Run as a **user-level** systemd service: `systemctl --user enable --now ydotool`
  - Socket: `/run/user/$UID/.ydotool_socket`
  - `/dev/uinput` udev rule ships with the `ydotool` package
  - **Only raw keycodes are accepted.** Name forms like `shift+Insert` are
    silently treated as a delay and exit 0 — they do nothing. `paste-text.ts`
    sends `42:1 110:1 110:0 42:0` (Shift+Insert) directly (commit `9e01cca`).
- Outstanding TODO: `paste-text.ts` could fall back to `wtype` when ydotool
  is unavailable.

### Submodule note
- `packages/whisper-wrapper/whisper.cpp` is a git submodule. The build
  (`bin/build-addon.js`) does **not** auto-init it — restore manually with
  `git submodule update --init packages/whisper-wrapper/whisper.cpp`.

---

## Build and release workflow

### Local dev
```bash
cd apps/desktop && ELECTRON_DISABLE_SANDBOX=1 pnpm start
```

### Release build (.deb + AppImage)
```bash
cd apps/desktop && pnpm make:linux
```
Outputs:
- `apps/desktop/out/make/AppImage/x64/Amical-<version>-x64.AppImage`
- `apps/desktop/out/make/deb/x64/amical_<version>_amd64.deb`

### Pre-release on GitHub
- Tag: `v1.1.0-linux.N` (incremental on the same `1.1.0` base)
- Repo: `tosihide/amical`, marked `--prerelease`
- Notes: **English required**; Japanese optional. When adding Japanese,
  put it after the English section under `## 日本語`.

```bash
gh release create v1.1.0-linux.N \
  --repo tosihide/amical --target <branch> --prerelease \
  --title "v1.1.0-linux.N (<distro/context>)" \
  --notes "$(cat <<'EOF'
...English notes...
EOF
)" \
  apps/desktop/out/make/deb/x64/amical_*.deb \
  apps/desktop/out/make/AppImage/x64/Amical-*.AppImage
```

---

## Cross-machine / cross-distro testing

When working on a different machine, OS version, distro, or desktop
environment (e.g. KDE, Fedora):

- Project context above travels via this file. No setup required after
  `git clone` — Claude Code auto-loads `CLAUDE.md`.
- Document new environment-specific findings (e.g. KDE-specific quirks)
  inline here under "Known platform quirks", so they propagate back to
  every machine on the next `git pull`.
- Personal preferences/feedback stay machine-local under `~/.claude/`.

---

## Local research notes

Investigation outputs that should not enter git history go to
`/NOTES_<topic>.md` at the repo root (already in `.gitignore`).
