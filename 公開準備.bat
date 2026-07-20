@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

title DIGITAL TATTOO — 公開準備
echo.
echo ========================================
echo   DIGITAL TATTOO — Web公開用ビルド
echo ========================================
echo.
echo この作業は「公開する人」だけが行います。
echo 訪問者は Node.js もコマンドも不要です。
echo URL を開くだけで作品を体験できます。
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [エラー] Node.js が見つかりません。
  echo.
  echo 公開準備には Node.js LTS が必要です。
  echo 次のサイトからインストールしてください:
  echo   https://nodejs.org
  echo.
  echo インストール後、このファイルをもう一度ダブルクリックしてください。
  echo.
  start "" "https://nodejs.org"
  pause
  exit /b 1
)

echo [1/4] 依存関係をインストールしています...
call npm install
if errorlevel 1 (
  echo.
  echo [エラー] npm install に失敗しました。
  pause
  exit /b 1
)

echo.
echo [2/4] モデルを取得しています（既定 1.5B・初回は約 840 MB）...
echo       ※ 実行中の作品は Hugging Face に接続しません。
echo       ※ ここで取得したファイルを dist/models に同梱します。
echo       ※ WebLLM 用に models/.../resolve/main/ 配置になります。
echo       ※ 軽量 0.5B: npm run fetch-model:lite
echo       ※ 高精度 3B（要VRAM・約 1.7 GB）: npm run fetch-model:hq
echo       ※ 全部入れると合計 ≈ 2.8 GB（GitHub Pages 非推奨 → Netlify 等）
call npm run fetch-model
if errorlevel 1 (
  echo.
  echo [エラー] モデル取得に失敗しました。ネット接続を確認して再実行してください。
  pause
  exit /b 1
)

echo.
echo [3/4] モデル配置を検証しています...
call npm run verify-models
if errorlevel 1 (
  echo.
  echo [エラー] モデルが不完全です。上のメッセージを確認してください。
  pause
  exit /b 1
)

echo.
echo [4/4] 静的サイトをビルドしています（dist/）...
call npm run build
if errorlevel 1 (
  echo.
  echo [エラー] ビルドに失敗しました。
  pause
  exit /b 1
)

if not exist "dist\index.html" (
  echo [エラー] dist\index.html がありません。
  pause
  exit /b 1
)

call npm run verify-models -- dist
if errorlevel 1 (
  echo.
  echo [エラー] dist/models が不完全です。アップロードしないでください。
  pause
  exit /b 1
)

echo.
echo ========================================
echo   完了
echo ========================================
echo.
echo 次のステップ（訪問者向けの公開）:
echo   1. 開いた dist フォルダの中身をすべて静的ホストへアップロード
echo      （Netlify / Cloudflare Pages / GitHub Pages / S3 / VPS の nginx など）
echo.
echo   ★ Netlify ドラッグ＆ドロップの注意:
echo      ・アップロードするのは dist の中身すべて（models 含む・既定 ≈ 840 MB）
echo      ・軽量/高精度も入れる場合は fetch-model:lite / :hq / :all してから再ビルド
echo      ・models 無し・一部欠けのまま公開すると LLM は 404 で失敗します
echo      ・再公開する場合も 公開準備.bat を再実行してからフル再アップロード
echo.
echo   2. 訪問者は https://あなたのドメイン/ を開くだけ
echo      Chrome または Edge（WebGPU）推奨
echo      ゲートで標準(1.5B) / 軽量(0.5B) / 高精度(3B) を選べます（未配置はグレーアウト）
echo.
echo dist フォルダをエクスプローラーで開きます...
echo.

start "" explorer "%~dp0dist"
pause
exit /b 0
