# AGENTS.md — vibe-usage-desktop

## 發佈 / 版號

本專案與 vibe-usage-local-server 是直接分發 build 給使用者（非 npm 發佈）。`npm run dist` 產出的安裝檔檔名帶 package.json 版號，是使用者分辨新舊 build 的唯一依據。

規則：每次要把 build 交給別人之前——

1. `npm version patch`（自動建 commit + tag `vX.Y.Z`）；累積的功能量值得明確標記時才升 minor
2. 共用檔案（`server/ui/dashboard.html` ↔ local-server 的 `src/ui/dashboard.html`）同步修改時，兩邊各自 bump
3. push 帶 tag：`git push --follow-tags`

## README 雙語同步

- `README.md`（英，**權威版**）與 `README.zh-TW.md`（繁中譯本）內容必須一致——改任一邊，同一個 commit 內同步另一邊
- 段落、程式碼區塊、表格、連結一一對應；錨點依各語言標題各自維護

## cli/ vendor 來源

`cli/` 由 `scripts/sync-cli.sh` 從 sibling checkout 的 HEAD vendor——來源應為本專案 fork `jwcrystal/vibe-usage`（基於 `vibe-cafe/vibe-usage`）。對 CLI 的修改進 fork 的分支，不要直接改 `cli/`（會被下次 sync 蓋掉）。
