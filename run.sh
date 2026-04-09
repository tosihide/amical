#!/bin/bash
# ============================================================
#  Amical Desktop — Linux クイックリファレンス
# ============================================================
#
#  ■ 開発時の起動（このスクリプト）
#      ./run.sh
#      または: cd apps/desktop && ELECTRON_DISABLE_SANDBOX=1 pnpm start
#
#  ■ パッケージビルド（.deb + AppImage）
#      cd apps/desktop && pnpm make:linux
#      ※ 初回のみ事前準備が必要:
#        pnpm download-node
#        convert assets/logo.svg -resize 256x256 assets/logo.png
#
#  ■ 出力先
#      apps/desktop/out/make/deb/x64/amical_<ver>_amd64.deb
#      apps/desktop/out/make/AppImage/x64/Amical-<ver>-x64.AppImage
#
#  ■ 注意事項
#    - --targets フラグは使わないこと（forge.config.ts の設定が無視される）
#    - 開発時は ELECTRON_DISABLE_SANDBOX=1 が必要
#    - .deb インストール後は ELECTRON_DISABLE_SANDBOX 不要（SUID 設定済み）
#    - AppImage は --no-sandbox が自動付与される
#
#  詳細: apps/desktop/docs/linux-deb-packaging.md
# ============================================================

cd /_O/amical/apps/desktop && ELECTRON_DISABLE_SANDBOX=1 pnpm start

