/* A generated project dashboard's live part: repository facts, 14 days of commits, the latest commits, open pull
 * requests, contributors and, for a project that builds on another, how far it is ahead of and behind that one.
 * Public GitHub API without a token (60 requests an hour per visitor); every answer is cached for ten minutes, so a
 * page costs about six requests the first time and none on reloads. Text from GitHub goes through Dash.scrub. */
(function () {
  'use strict';
  const { esc, scrub, ago, data } = window.Dash;
  const API = 'https://api.github.com';
  const CACHE_MS = 10 * 60 * 1000;
  const DAYS = 14;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const COMMITS_SHOWN = 8;
  const PULLS_SHOWN = 8;
  const PEOPLE_SHOWN = 16;
  const TOKEN_KEY = 'ldash:token';            // shared with the hand-made dashboards: one token serves every page
  const TOKEN_RE = /^(gh[pousr]_|github_pat_)[A-Za-z0-9_]+$/;

  const d = data();
  if (!d || !d.project) return;
  const repo = d.project.repo;
  const $ = id => document.getElementById(id);

  async function api(path) {
    const key = 'gh-cache:' + path;
    try {
      const hit = JSON.parse(localStorage.getItem(key) || 'null');
      if (hit && Date.now() - hit.at < CACHE_MS) return hit.body;
    } catch (e) { /* unreadable cache entry: ask GitHub again */ }
    const headers = { Accept: 'application/vnd.github+json' };
    const token = readToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(API + path, { headers });
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      const when = reset ? ` until ${new Date(reset).toLocaleTimeString()}` : '';
      throw Object.assign(new Error(`GitHub's hourly allowance for this browser is used up${when}`), { limited: true });
    }
    if (!res.ok) throw Object.assign(new Error(`GitHub answered ${res.status}`), { status: res.status });
    const body = await res.json();
    try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), body })); } catch (e) { /* storage full or private mode */ }
    return body;
  }

  function readToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  // A shared IP (a VPN, an office) often has used up the 60 unauthenticated requests an hour. A read-only token
  // raises that to 5,000; it stays in this browser and goes only to api.github.com.
  function tokenForm() {
    if (readToken()) return '';
    return `<form class="token-form"><input type="password" placeholder="GitHub token (no scopes needed)" aria-label="GitHub token" autocomplete="off">`
      + `<button class="btn" type="submit">Use token</button></form>`;
  }

  function fail(el, err) {
    if (!el) return;
    el.innerHTML = `<div class="fail"><span class="err">${esc(err.message)}.</span> <a href="https://github.com/${esc(repo)}" target="_blank" rel="noopener">Open on GitHub ↗</a>${err.limited && el.id === 'repo-facts' ? tokenForm() : ''}</div>`;
    const form = el.querySelector('.token-form');
    if (!form) return;
    form.addEventListener('submit', ev => {
      ev.preventDefault();
      const v = form.querySelector('input').value.trim();
      if (!TOKEN_RE.test(v)) { form.querySelector('input').setCustomValidity('That does not look like a GitHub token'); form.reportValidity(); return; }
      try { localStorage.setItem(TOKEN_KEY, v); } catch (e) { console.warn('token not stored:', e); }
      location.reload();
    });
  }

  function firstLine(message) {
    return scrub(String(message || '').split('\n')[0]).slice(0, 140);
  }

  async function info() {
    const r = await api(`/repos/${repo}`);
    $('c-stars').textContent = (r.stargazers_count || 0).toLocaleString();
    $('c-pushed').textContent = ago(r.pushed_at) || '–';
    const rows = [
      ['Created', r.created_at ? new Date(r.created_at).toLocaleDateString() : '–'],
      ['Licence', r.license ? r.license.spdx_id : 'none stated'],
      ['Language', r.language || '–'],
      ['Default branch', r.default_branch],
      ['Forks', (r.forks_count || 0).toLocaleString()],
      ['Open issues and PRs', (r.open_issues_count || 0).toLocaleString()],
    ];
    if (r.archived) rows.unshift(['State', 'archived']);
    $('repo-facts').innerHTML = rows.map(([k, v]) => `<div><span>${esc(k)}</span>${esc(v)}</div>`).join('');
    return r;
  }

  async function commits(branch) {
    const since = new Date(Date.now() - DAYS * DAY_MS).toISOString();
    const list = await api(`/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=100&since=${since}`);
    const counts = new Array(DAYS).fill(0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (const c of list) {
      const t = new Date(c.commit.committer.date || c.commit.author.date); t.setHours(0, 0, 0, 0);
      const back = Math.round((today - t) / DAY_MS);
      if (back >= 0 && back < DAYS) counts[DAYS - 1 - back] += 1;
    }
    const max = Math.max(1, ...counts);
    const label = i => new Date(today.getTime() - (DAYS - 1 - i) * DAY_MS).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const capped = list.length >= 100 ? ' (100 or more: GitHub returns at most 100 here)' : '';
    $('bars').innerHTML = counts.map((n, i) => `<div class="b" title="${esc(label(i))}: ${n} commit${n === 1 ? '' : 's'}"><em>${n || ''}</em><i style="height:${(n / max) * 100}%"></i>${i % 2 ? '' : esc(label(i))}</div>`).join('')
      + `<span class="note" style="grid-column:1/-1">${list.length} commits in ${DAYS} days${esc(capped)}</span>`;
    const latest = list.length ? list : await api(`/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${COMMITS_SHOWN}`);
    $('commits').innerHTML = latest.slice(0, COMMITS_SHOWN).map(c => {
      const who = c.author ? c.author.login : (c.commit.author && c.commit.author.name) || 'unknown';
      return `<li><a href="${esc(c.html_url)}" target="_blank" rel="noopener">${esc(firstLine(c.commit.message))}</a><span class="meta">${esc(scrub(who))} · ${esc(ago(c.commit.committer.date))}</span></li>`;
    }).join('') || '<li class="busy">No commits.</li>';
  }

  async function pulls() {
    const list = await api(`/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${PULLS_SHOWN}`);
    $('pulls').innerHTML = list.map(p => `<li><a href="${esc(p.html_url)}" target="_blank" rel="noopener">#${p.number} ${esc(firstLine(p.title))}</a><span class="meta">${esc(scrub(p.user ? p.user.login : ''))} · updated ${esc(ago(p.updated_at))}${p.draft ? ' · draft' : ''}</span></li>`).join('')
      || '<li class="busy">No open pull requests.</li>';
  }

  async function people() {
    const list = await api(`/repos/${repo}/contributors?per_page=${PEOPLE_SHOWN}`);
    $('people-list').innerHTML = (Array.isArray(list) ? list : []).map(u => `<a href="${esc(u.html_url)}" target="_blank" rel="noopener"><img src="${esc(u.avatar_url)}&s=56" alt="" loading="lazy">${esc(scrub(u.login))} <small>${u.contributions}</small></a>`).join('')
      || '<span class="busy">No contributors listed.</span>';
  }

  async function upstream(own) {
    const el = $('upstream-body');
    if (!el || !d.base) return;
    const base = await api(`/repos/${d.base.repo}`);
    const owner = repo.split('/')[0];
    const head = `${base.default_branch}...${owner}:${repo.split('/')[1]}:${own.default_branch}`;
    let cmp = null;
    try {
      cmp = await api(`/repos/${d.base.repo}/compare/${encodeURIComponent(head).replace(/%3A/g, ':').replace(/%2E/g, '.')}`);
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    const baseLine = `${esc(d.base.name)} last pushed ${esc(ago(base.pushed_at))}; this project ${esc(ago(own.pushed_at))}.`;
    if (!cmp) {
      el.innerHTML = `<p>Not a GitHub fork of <b>${esc(d.base.name)}</b>, so the two histories can't be compared here. ${baseLine}</p>`;
      return;
    }
    el.innerHTML = `<div class="tiles"><div class="tile"><b>${cmp.ahead_by}</b><span>commits ahead of ${esc(d.base.name)}</span></div>`
      + `<div class="tile"><b>${cmp.behind_by}</b><span>commits behind it</span></div></div><p class="note">${baseLine}</p>`;
  }

  (async () => {
    let own = null;
    try { own = await info(); } catch (err) { fail($('repo-facts'), err); fail($('upstream-body'), err); }
    const branch = own ? own.default_branch : 'HEAD';
    await Promise.all([
      commits(branch).catch(err => { fail($('bars'), err); fail($('commits'), err); }),
      pulls().catch(err => fail($('pulls'), err)),
      people().catch(err => fail($('people-list'), err)),
      own ? upstream(own).catch(err => fail($('upstream-body'), err)) : Promise.resolve(),
    ]);
  })();
})();
