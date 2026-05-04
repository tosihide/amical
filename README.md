<!-- Markdown with HTML -->
<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://amical.ai/github-readme-header-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://amical.ai/github-readme-header-light.png">
  <img alt="Amical" src="https://amical.ai/github-readme-header-light.png">
</picture>
</div>

<p align="center">
  <a href='http://makeapullrequest.com'>
    <img alt='PRs Welcome' src='https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=shields'/>
  </a>
  <a href="https://opensource.org/license/MIT/">
    <img src="https://img.shields.io/github/license/amicalhq/amical?logo=opensourceinitiative&logoColor=white&label=License&color=8A2BE2" alt="license">
  </a>
  <br>
  <a href="https://amical.ai/community">
    <img src="https://img.shields.io/badge/discord-7289da.svg?style=flat-square&logo=discord" alt="discord" style="height: 20px;">
  </a>
</p>

<p align="center">
  <a href="https://amical.ai">Website</a> - <a href="https://amical.ai/docs">Docs</a> - <a href="https://amical.ai/community">Community</a> - <a href="https://github.com/amicalhq/amical/issues/new?assignees=&labels=bug&template=bug_report.md">Bug reports</a>
</p>

## Table of Contents

- [⬇️ Download](#️-download)
- [🔮 Overview](#-overview)
- [✨ Features](#-features)
- [🔰 Tech Stack](#-tech-stack)
- [Linux Setup](#linux-setup)
- [🤗 Contributing](#-contributing)
- [🎗 License](#-license)

## ⬇️ Download

<p>
  <a href="https://github.com/amicalhq/amical/releases/latest">
    <img src="https://amical.ai/download_button_macos.png" alt="Download for macOS" height="60">
  </a>
  <a href="https://github.com/amicalhq/amical/releases/latest">
    <img src="https://amical.ai/download_button_windows.png" alt="Download for Windows" height="60">
  </a>
  <a href="https://amical.ai/beta">
    <img src="https://amical.ai/mobile_beta_button.svg" alt="Apply for Mobile Beta" height="60">
  </a>
</p>

### Homebrew (macOS)

```bash
brew install --cask amical
```

## 🔮 Overview

Local-first AI Dictation app.

Amical is an open source AI-powered dictation and note-taking app that runs entirely on your machine.
Powered by [Whisper](https://github.com/openai/whisper) for speech-to-text and open source LLMs for intelligent processing, Amical gives you the power of AI dictation with complete privacy.

Context-aware dictation that adapts to what you're doing: drafting an email, chatting on Discord, writing prompts in your IDE, or messaging friends. Amical detects the active app and formats your speech accordingly.

<p align="center">
  <img src="https://amical.ai/demo/dictation-demo-component.gif" alt="Amical dictation demo" width="600">
</p>

## ✨ Features

> ✔︎ - Done, ◑ - In Progress, ◯ - Planned

🚀 Super-fast dictation with AI-enhanced accuracy ✔︎

🧠 Context-aware speech-to-text based on the active app ✔︎

📒 Smart voice notes → summaries, tasks, structured notes ◑

🔌 MCP integration → voice commands that control your apps ◯

🎙️ Real-time meeting transcription (mic + system audio) ◯

🔧 Extensible via hotkeys, voice macros, custom workflows ✔︎

🔐 Privacy-first: works offline, one click setup of local models in-app ✔︎

🪟 Floating widget for frictionless start/stop with custom hotkeys ✔︎

## 🔰 Tech Stack

- 🎤 [Whisper](https://github.com/openai/whisper)
- 🦙 [Ollama](https://ollama.ai)
- 🧑‍💻 [Typescript](https://www.typescriptlang.org/)
- 🖥️ [Electron](https://electronjs.org/)
- ☘️ [Next.js](https://nextjs.org/)
- 🎨 [TailwindCSS](https://tailwindcss.com/)
- 🧑🏼‍🎨 [Shadcn](https://ui.shadcn.com/)
- 🔒 [Better-Auth](https://better-auth.com/)
- 🧘‍♂️ [Zod](https://zod.dev/)
- 🐞 [Jest](https://jestjs.io/)
- 📚 [Fumadocs](https://github.com/fuma-nama/fumadocs)
- 🌀 [Turborepo](https://turbo.build/)

## Linux Setup

> **Note:** Linux support requires a **Wayland** session. X11 is not supported (clipboard and paste features depend on Wayland protocols).

Keyboard shortcut monitoring requires access to `/dev/input/event*` (evdev). Add your user to the `input` group and re-login:

```bash
sudo usermod -aG input $USER
```

Paste simulation (`ydotool`) requires write access to `/dev/uinput`. Set up a udev rule and re-login:

```bash
echo 'KERNEL=="uinput", GROUP="input", MODE="0660"' | sudo tee /etc/udev/rules.d/80-uinput.rules
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Other dependencies:

```bash
sudo apt install wl-clipboard ydotool gstreamer1.0-plugins-good pulseaudio-utils
```

See [apps/desktop/docs/linux-setup.md](apps/desktop/docs/linux-setup.md) for full setup guide.

### Running the development build (Linux)

How to launch the development build:

```bash
# Normal dev start
cd apps/desktop && ELECTRON_DISABLE_SANDBOX=1 pnpm start

# Remote debugging (to attach via Chrome DevTools Protocol)
cd apps/desktop && ELECTRON_DISABLE_SANDBOX=1 pnpm start -- --remote-debugging-port=9222
```

Notes:

- `ELECTRON_DISABLE_SANDBOX=1` is only needed during development (after `.deb` install it is SUID-configured and unnecessary; AppImage launches with `--no-sandbox` automatically).
- Package build: `cd apps/desktop && pnpm make:linux` (do not use the `--targets` flag — it causes `forge.config.ts` settings to be ignored).
- Output: `apps/desktop/out/make/deb/x64/amical_<ver>_amd64.deb` / `apps/desktop/out/make/AppImage/x64/Amical-<ver>-x64.AppImage`
- See [apps/desktop/docs/linux-deb-packaging.md](apps/desktop/docs/linux-deb-packaging.md) for details.

## 🤗 Contributing

Contributions are welcome! Reach out to the team in our [Discord server](https://amical.ai/community) to learn more.

- **🐛 [Report an Issue][issues]**: Found a bug? Let us know!
- **💬 [Start a Discussion][discussions]**: Have ideas or suggestions? We'd love to hear from you.

## 🎗 License

Released under [MIT][license].

<!-- REFERENCE LINKS -->

[license]: https://github.com/amicalhq/amical/blob/main/LICENSE
[discussions]: https://amical.ai/community
[issues]: https://github.com/amicalhq/amical/issues
[pulls]: https://github.com/amicalhq/amical/pulls "submit a pull request"
