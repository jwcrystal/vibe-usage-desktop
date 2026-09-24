# AGENTS.md — vibe-usage-desktop

## 發佈 / 版號

本專案與 vibe-usage-local-server 是直接分發 build 給使用者（非 npm 發佈）。`npm run dist` 產出的安裝檔檔名帶 package.json 版號，是使用者分辨新舊 build 的唯一依據。

規則：每次要把 build 交給別人之前——

1. `npm version patch`（自動建 commit + tag `vX.Y.Z`）；累積的功能量值得明確標記時才升 minor
2. 共用檔案（`server/ui/dashboard.html` ↔ local-server 的 `src/ui/dashboard.html`）同步修改時，兩邊各自 bump
3. push 帶 tag：`git push --follow-tags`
