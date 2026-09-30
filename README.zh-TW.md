# vibe-usage-desktop

[English](README.md) | 繁體中文

[vibe-usage-local-server](https://github.com/jwcrystal/vibe-usage-local-server) 的
跨平台桌面外殼（macOS / Windows / Linux）——Electron 應用，內嵌零依賴本地伺服器並顯示其 dashboard。

- 系統匣圖示 + 選單：開啟 dashboard、登入自啟、結束
- 內嵌伺服器跑在 `http://127.0.0.1:3456`（同一資料檔
  `~/.vibe-usage-server/data.json`、同一張價格表）
- 關閉視窗後應用留在系統匣；要結束請由匣選單
- 若 port 3456 已被占用（例如 launchd agent），應用會直接連上執行中的伺服器——不衝突、共用資料

## 安裝

```bash
npm install
npm start
```

`server/` 與 `cli/` 是已提交的 vendor 快照——不需要任何 sibling checkout 即可建置與執行。要刷新快照，先把來源 repo 複製到本專案隔壁，再重新同步：

```bash
git clone https://github.com/jwcrystal/vibe-usage-local-server ../vibe-usage-local-server
git clone https://github.com/jwcrystal/vibe-usage ../vibe-usage   # vibe-cafe/vibe-usage 的 fork
npm run sync-server   # vendor ../vibe-usage-local-server/src -> ./server
npm run preflight     # vendor ../vibe-usage @HEAD -> ./cli
```

## Smoke test

```bash
npm run smoke         # 啟動內嵌伺服器，GET /，以 0/1 結束
```

## 建置安裝檔

```bash
npm run dist:mac      # dist/ Vibe Usage Desktop.dmg（未簽署）
npm run dist:win      # dist/ NSIS installer
npm run dist:linux    # dist/ AppImage
npm run dist          # 三平台全部（可從任何主機跨建）
```

## Icon

`icon-source.svg` 改編自
[vibe-usage-app](https://github.com/vibe-cafe/vibe-usage-app) 的 pixel-art mark
（改色為靛藍底白圖；上游為 MIT）。重新產生：

```bash
magick -background none icon-source.svg -resize 1024x1024 build/icon.png
```

## 致謝

- [`cli/`](cli/) — vendored 自我們的 fork [jwcrystal/vibe-usage](https://github.com/jwcrystal/vibe-usage)（MIT，基於 [vibe-cafe/vibe-usage](https://github.com/vibe-cafe/vibe-usage)），由 `scripts/sync-cli.sh` 重新同步
- [`server/`](server/) — vendored 自 [vibe-usage-local-server](https://github.com/jwcrystal/vibe-usage-local-server)
- 應用圖示改編自 [vibe-usage-app](https://github.com/vibe-cafe/vibe-usage-app)（MIT）

## License

MIT — 見 [LICENSE](LICENSE)。`cli/` 內含 vendored 上游程式碼（MIT），
詳見 [cli/NOTICE](cli/NOTICE)。
