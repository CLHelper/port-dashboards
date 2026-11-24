/* The milestone ladder: one bar from the first stage to the last, filled to the highlighted project's score, with a
 * pin (owner avatar) per project. Dash.ladder(host, ladder, markers, highlight). Pins that would overlap are nudged
 * apart; the highlighted one gets a label. Used on the standings page, every project page and the hand-made pages. */
(function () {
  'use strict';
  const { esc } = window.Dash;
  const MIN_GAP_PCT = 2.6;   // pins closer than this are spread out so each avatar stays clickable
  const MAX_PINS = 30;

  function spread(pins) {
    const sorted = pins.slice().sort((a, b) => a.score - b.score);
    let last = -Infinity;
    for (const p of sorted) {
      p.x = Math.max(p.score, last + MIN_GAP_PCT);
      last = p.x;
    }
    const over = last - 99;
    if (over > 0) sorted.forEach(p => { p.x -= over * (p.x / last); });
    return sorted;
  }

  function render(host, ladder, markers, highlight) {
    if (!host || !Array.isArray(ladder) || !ladder.length) return;
    const hl = (markers || []).find(m => m.slug === highlight);
    const fill = hl ? hl.score : 0;
    const pins = spread((markers || []).slice(0, MAX_PINS).map(m => Object.assign({}, m)));
    const ticks = ladder.slice(1, -1).map(s => `<span class="tick" style="left:${s.pct}%"></span>`).join('');
    const stops = ladder.map(s => `<div class="stop${fill >= s.pct ? ' reached' : ''}" style="left:${s.pct}%" title="${esc(s.means)}"><b>${s.pct}%</b><span>${esc(s.label)}</span></div>`).join('');
    const pinHtml = pins.map(p => {
      const isHl = p.slug === highlight;
      const img = p.avatar ? `<img src="${esc(p.avatar)}" alt="" loading="lazy">` : '<span class="ph"></span>';
      const label = isHl ? `<span class="tag">${esc(p.name)} · ${p.score}%</span>` : '';
      return `<div class="pin${isHl ? ' hl' : hl ? ' dim' : ''}" style="left:${p.x}%" title="${esc(p.name)}: ${p.score}%">${label}<a href="${esc(p.href)}" aria-label="${esc(p.name)}, ${p.score}%">${img}</a><span class="stem"></span></div>`;
    }).join('');
    host.innerHTML = `<div class="ladder">${pinHtml}<div class="track"><div class="fill" style="width:${fill}%"></div>${ticks}</div><div class="stops">${stops}</div></div>`;
  }

  window.Dash.ladder = render;
  const d = window.Dash.data();
  const host = document.getElementById('ladder');
  if (d && host && d.ladder) render(host, d.ladder, d.markers, d.highlight);
})();
