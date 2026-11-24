/* Standings page: each row's "last push" from GitHub, live. One request per page load for all rows (the search API
 * accepts many repos at once), cached for ten minutes so reloads don't spend the visitor's hourly allowance. */
(function () {
  'use strict';
  const { esc, ago } = window.Dash;
  const CACHE_KEY = 'standings-pushed-v1';
  const CACHE_MS = 10 * 60 * 1000;
  const rows = Array.from(document.querySelectorAll('.row[data-repo]'));
  const show = pushed => rows.forEach(row => {
    const el = row.querySelector('.pushed');
    const at = pushed[row.dataset.repo.toLowerCase()] || el.dataset.pushed;
    el.innerHTML = at ? `last push <time datetime="${esc(at)}">${esc(ago(at))}</time>` : '';
  });
  show({});
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { cached = null; }
  if (cached && Date.now() - cached.at < CACHE_MS) { show(cached.pushed); return; }
  const q = rows.map(r => 'repo:' + r.dataset.repo).join(' ');
  fetch('https://api.github.com/search/repositories?per_page=100&q=' + encodeURIComponent(q), { headers: { Accept: 'application/vnd.github+json' } })
    .then(r => (r.ok ? r.json() : Promise.reject(new Error('GitHub answered ' + r.status))))
    .then(j => {
      const pushed = {};
      for (const it of j.items || []) pushed[it.full_name.toLowerCase()] = it.pushed_at;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), pushed })); } catch (e) { /* private mode: no cache */ }
      show(pushed);
    })
    .catch(err => console.warn('standings: live push times unavailable, showing the build-time ones:', err.message));
})();

/* The ring's number counts up while the ring fills (the CSS animation in site.css). */
(function () {
  'use strict';
  const el = document.querySelector('.ring-center .pct[data-count]');
  if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const to = Number(el.dataset.count);
  const small = el.querySelector('small').outerHTML;
  const DURATION_MS = 1400;
  const start = performance.now();
  const step = now => {
    const t = Math.min(1, (now - start) / DURATION_MS);
    const v = to * (1 - Math.pow(1 - t, 3));
    el.innerHTML = (t < 1 ? Math.round(v) : to) + small;
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
})();
