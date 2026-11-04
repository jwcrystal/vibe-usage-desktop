// About window content. Kept as a module so main.js owns the window lifecycle
// and the HTML can be rendered in isolation (tests, layout checks).

const REPO_URL = 'https://github.com/jwcrystal/vibe-usage-desktop';

function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// Plain-text block used by the Copy button and by bug reports.
export function aboutText({ version, cli, electron, chromium, node }) {
  return [
    `版本 ${version}`,
    cli ? `內嵌 CLI ${cli}` : null,
    `Electron ${electron} · Chromium ${chromium} · Node ${node}`,
    REPO_URL,
  ].filter(Boolean).join('\n');
}

export function aboutHtml({ version, cli, electron, chromium, node, iconDataUrl }) {
  const rows = [
    ['內嵌 CLI', cli || '—'],
    ['Electron', electron],
    ['Chromium', chromium],
    ['Node', node],
  ].map(([label, value]) => (
    `<dt>${esc(label)}</dt><dd title="${esc(value)}">${esc(value)}</dd>`
  )).join('');

  return `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; background: transparent; }
  * { box-sizing: border-box; }
  #card {
    height: 100%; display: flex; flex-direction: column; gap: 13px;
    padding: 20px 22px 16px;
    background: #1c1c1e; color: #ffffff;
    border: 1px solid #3a3a3c; border-radius: 10px;
    font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", sans-serif;
    -webkit-user-select: none; user-select: none;
  }
  .head { display: flex; align-items: center; gap: 12px; }
  .icon { width: 44px; height: 44px; border-radius: 10px; }
  .name { font-size: 15px; font-weight: 700; line-height: 1.2; }
  .ver { margin-top: 3px; color: #a1a1a1; font-size: 10.5px; }
  .ver b { color: #33cc99; font-weight: 600; font-variant-numeric: tabular-nums; }
  .divider { height: 1px; background: #333333; }
  .rows {
    display: grid; grid-template-columns: auto minmax(0, 1fr);
    gap: 8px 14px; margin: 0; font-size: 11.5px;
  }
  .rows dt { color: #8e8e93; }
  .rows dd {
    margin: 0; text-align: right; color: #d4d4d4;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #repo {
    color: #6e6e6e; font-size: 10px; text-align: center; text-decoration: none;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #repo:hover { color: #a1a1a1; text-decoration: underline; }
  .foot { margin-top: auto; display: flex; gap: 8px; }
  button {
    flex: 1; padding: 7px 0; border-radius: 5px; font-size: 11.5px;
    font-family: inherit; cursor: pointer;
  }
  #copy { background: #2f2f2f; color: #ffffff; border: 1px solid #4a4a4a; }
  #copy:hover { background: #3a3a3a; }
  #close { background: transparent; color: #a1a1a1; border: 1px solid #3a3a3c; }
  #close:hover { border-color: #858585; color: #ffffff; }
  :focus-visible { outline: 2px solid #33cc99; outline-offset: 2px; }
</style><body><div id="card">
  <div class="head">
    ${iconDataUrl ? `<img class="icon" src="${esc(iconDataUrl)}" alt="">` : ''}
    <div>
      <div class="name">Vibe Usage Desktop</div>
      <div class="ver">版本 <b>${esc(version)}</b></div>
    </div>
  </div>
  <div class="divider"></div>
  <dl class="rows">${rows}</dl>
  <a id="repo" href="${REPO_URL}">github.com/jwcrystal/vibe-usage-desktop</a>
  <div class="foot">
    <button id="copy">複製版本資訊</button>
    <button id="close">關閉</button>
  </div>
</div><script>
  const bridge = window.vibeDesktop;
  const copy = document.getElementById('copy');
  copy.addEventListener('click', async () => {
    if (!bridge || !bridge.copyVersionInfo) return;
    try {
      await bridge.copyVersionInfo();
      copy.textContent = '已複製';
      setTimeout(() => { copy.textContent = '複製版本資訊'; }, 1200);
    } catch { copy.textContent = '複製失敗'; }
  });
  document.getElementById('close').addEventListener('click', () => window.close());
  document.getElementById('repo').addEventListener('click', (e) => {
    e.preventDefault();
    if (bridge && bridge.openExternal) bridge.openExternal('${REPO_URL}');
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });
</script></body>`;
}
