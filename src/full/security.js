'use strict';
/*
 * "Security reviews": the shared table of pull requests that volunteers have read for malicious code, kept in
 * Etoile-Bleu/leonida-reviews (one file per PR; docs/reviews.json is the generated list of all of them). Read through
 * raw.githubusercontent.com (no rate limit) every SEC_MS while the tab is visible. The checked entries are kept in
 * localStorage packed (each distinct scope text once, about 0.3 MB), so a reload shows them at once.
 * Everything in it is text other people wrote: every field is type-checked here and escaped when shown.
 * Loaded after the inline script in index.html and pipeline.js; uses $, esc, fmt, scrub, ago, GH and, when the
 * pipeline has loaded, pipe.prs to tell which reviewed PRs are still open.
 */

const SEC_SOURCE = 'Etoile-Bleu/leonida-reviews';
const SEC_URL = `https://raw.githubusercontent.com/${SEC_SOURCE}/main/docs/reviews.json`;
const SEC_REPO_URL = `https://github.com/${SEC_SOURCE}`;
const SEC_MS = 15 * 60 * 1000;          // the table is rebuilt every 15 minutes
const SEC_TICK_MS = 60 * 1000;
const SEC_FIRST = 5;                     // cards shown before "Show more"
const SEC_PAGE = 20;                     // cards each "Show more" adds
const SEC_KEY = 'sec:v1';
const SEC_TEXT_MAX = 600;                // longest finding or scope kept per entry
const SHA_RE = /^[0-9a-f]{7,40}$/;
// The table reviews the pull requests of the original repository, which went private on 2026-11-23. Shown for another
// repository, its numbers are not that repository's: they are not linked and not matched against its open PRs.
const SEC_REVIEWED_REPO = 'ItsNotRexed/Leonida';
const secOwnRepo = () => REPO === SEC_REVIEWED_REPO;

// Most serious first: the boxes, the groups and the "most serious first" order follow this list.
const VERDICTS = [
  { key: 'do-not-merge', label: 'Do not merge', box: 'should not be merged', mark: '✕', color: 'var(--todo)',
    help: 'A real problem was found. Read why before touching these.' },
  { key: 'notes', label: 'Needs a second look', box: 'need a second look', mark: '!', color: 'var(--sun)',
    help: 'Nothing malicious, but a remark a maintainer should read before merging.' },
  { key: 'scan-only', label: 'Quick scan only', box: 'only got a quick scan', mark: '~', color: 'var(--research)',
    help: 'A pattern scan ran over these; nobody read the change line by line.' },
  { key: 'not-reviewed', label: 'Could not be reviewed', box: 'could not be reviewed', mark: '?', color: 'var(--muted)',
    help: 'The reviewer could not read these, for example an empty or very large diff.' },
  { key: 'in-progress', label: 'Being reviewed', box: 'are being reviewed', mark: '…', color: 'var(--dim)',
    help: 'Claimed by a reviewer or queued; no verdict yet.' },
  { key: 'clean', label: 'Came back clean', box: 'came back clean', mark: '✓', color: 'var(--done)',
    help: 'Nothing malicious was found in what was checked. Not a promise that the PR is safe.' },
];
const VERDICT = Object.fromEntries(VERDICTS.map((v, i) => [v.key, { ...v, rank: i }]));
const SEC_ORDERS = [['serious', 'most serious first'], ['pr', 'newest PR first'], ['date', 'newest review first']];

const sec = {
  all: [],
  at: 0,
  busy: false,
  failed: '',
  openAt: 0,              // pipe.fullAt the open/closed tags were drawn with
  f: { verdict: '', reviewer: '', q: '', order: 'serious', remarks: false, hideAuto: false, openOnly: false },
  shown: SEC_FIRST,
};

const secStr = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** One review from the JSON, or null when it is not usable. Unknown fields are ignored. */
function secEntry(r) {
  if (!r || typeof r !== 'object') return null;
  const pr = Number(r.pr);
  if (!Number.isInteger(pr) || pr <= 0) return null;
  const verdict = secStr(r.verdict, 40);
  if (!VERDICT[verdict]) return null;
  const head = secStr(r.head, 40).toLowerCase();
  const date = secStr(r.date, 10);
  return {
    pr,
    verdict,
    reviewer: secStr(r.reviewer, 80) || 'unknown',
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
    head: SHA_RE.test(head) ? head : '',
    scope: scrub(secStr(r.scope, SEC_TEXT_MAX)),
    findings: (Array.isArray(r.findings) ? r.findings : []).map(f => scrub(secStr(f, SEC_TEXT_MAX))).filter(Boolean).slice(0, 12),
    title: scrub(secStr(r.title, 200)),
    author: secStr(r.author, 60),
    human: r.human === true,
    commented: r.commented === true,
    automated: r.automated === true,
  };
}

const SEC_FLAGS = ['human', 'commented', 'automated'];

/** The entries packed for localStorage: scopes once in a table, flags as bits. */
function secPack(all, at) {
  const scopes = [...new Set(all.map(r => r.scope))];
  const idx = new Map(scopes.map((t, i) => [t, i]));
  const rows = all.map(r => [r.pr, r.verdict, r.reviewer, r.date, r.head, idx.get(r.scope), r.findings, r.title, r.author,
    SEC_FLAGS.reduce((bits, k, i) => bits | (r[k] ? 1 << i : 0), 0)]);
  return { at, scopes, rows };
}

/** Saved entries back, through secEntry again (localStorage is not trusted either). */
function secUnpack(saved) {
  if (!saved || !Array.isArray(saved.rows) || !Array.isArray(saved.scopes) || !Number.isFinite(saved.at)) return null;
  const all = saved.rows.map(row => Array.isArray(row) && secEntry({
    pr: row[0], verdict: row[1], reviewer: row[2], date: row[3], head: row[4], scope: saved.scopes[row[5]], findings: row[6],
    title: row[7], author: row[8], ...Object.fromEntries(SEC_FLAGS.map((k, i) => [k, !!(row[9] & (1 << i))])),
  })).filter(Boolean);
  return all.length ? { all, at: saved.at } : null;
}

async function loadSecurity() {
  if (sec.busy) return;
  sec.busy = true;
  try {
    const { res, json } = await fetchTimed(SEC_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`the review table answered HTTP ${res.status}`);
    const raw = json();
    if (!Array.isArray(raw)) throw new Error('the review table is not a list');
    sec.all = raw.map(secEntry).filter(Boolean);
    sec.at = Date.now();
    sec.failed = '';
    store.set(SEC_KEY, secPack(sec.all, sec.at));
    renderSecurity();
  } catch (e) {
    console.error('[dashboard] security reviews', e);
    sec.failed = e.message;
    if (!sec.all.length) renderSecurity();
  } finally {
    sec.busy = false;
  }
}

/** Open PR numbers once the pipeline has a full list, else null (then nothing is tagged open or closed). */
function secOpenSet() {
  if (!secOwnRepo()) return null;
  return typeof pipe !== 'undefined' && pipe.fullAt && pipe.prs.size ? pipe.prs : null;
}

/** Every filter except the verdict one: the boxes count within these. */
function secInScope(r, open) {
  const f = sec.f;
  if (f.hideAuto && r.automated) return false;
  if (f.remarks && !r.findings.length) return false;
  if (f.reviewer && r.reviewer !== f.reviewer) return false;
  if (f.openOnly && open && !open.has(r.pr)) return false;
  const q = f.q.trim().toLowerCase().replace(/^#/, '');
  if (!q) return true;
  return [r.pr, r.title, r.author, r.reviewer, r.head, VERDICT[r.verdict].label, ...r.findings].join(' ').toLowerCase().includes(q);
}

function secSort(list) {
  const o = sec.f.order;
  if (o === 'pr') return list.sort((a, b) => b.pr - a.pr);
  if (o === 'date') return list.sort((a, b) => b.date.localeCompare(a.date) || b.pr - a.pr);
  return list.sort((a, b) => VERDICT[a.verdict].rank - VERDICT[b.verdict].rank || b.pr - a.pr);
}

function secCard(r, open) {
  const v = VERDICT[r.verdict];
  const state = open ? (open.has(r.pr) ? '<span class="sec-tag open">Open</span>' : '<span class="sec-tag">Closed or merged</span>') : '';
  const title = r.title ? `<span class="sec-title">${esc(r.title)}</span>` : '';
  const findings = r.findings.length
    ? `<ul class="sec-findings">${r.findings.map(f => `<li>${esc(f)}</li>`).join('')}</ul>`
    : `<p class="sec-none">${r.verdict === 'in-progress' ? 'No verdict yet.' : 'No remarks.'}</p>`;
  const commit = r.head ? `<span>commit ${secOwnRepo() ? `<a href="${GH}/commit/${r.head}" target="_blank" rel="noopener"><code>${esc(r.head.slice(0, 8))}</code></a>` : `<code>${esc(r.head.slice(0, 8))}</code>`}</span>` : '';
  const how = r.scope ? `<details class="sec-how"><summary>How it was checked</summary><p>${esc(r.scope)}</p></details>` : '';
  return `<article class="sec-card" style="--v:${v.color}">
    <div class="sec-top">
      ${secOwnRepo() ? `<a class="sec-pr" href="${GH}/pull/${r.pr}" target="_blank" rel="noopener">#${r.pr}</a>` : `<span class="sec-pr" title="A pull request of the original repository, which went private">#${r.pr}</span>`}${title}
      <span class="sec-pills">${r.automated ? '<span class="sec-tag">Automated scan</span>' : ''}${state}<span class="sec-pill">${v.mark} ${esc(v.label)}</span></span>
    </div>
    ${findings}
    <div class="sec-meta">
      <span>Checked by ${esc(r.reviewer)}</span>${r.date ? `<span>${esc(r.date)}</span>` : ''}${commit}
      <span>${r.human ? 'A human read the diff' : 'Read by AI only'}</span>${r.commented ? '<span>Remark posted on the PR</span>' : ''}
    </div>
    ${how}
  </article>`;
}

function secList(open) {
  const f = sec.f;
  const list = secSort(sec.all.filter(r => secInScope(r, open) && (!f.verdict || r.verdict === f.verdict)));
  const shown = list.slice(0, sec.shown);
  const parts = [];
  let group = '';
  for (const r of shown) {
    if (f.order === 'serious' && r.verdict !== group) {
      group = r.verdict;
      const v = VERDICT[group];
      const n = list.filter(x => x.verdict === group).length;
      parts.push(`<div class="sec-group" style="--v:${v.color}"><span class="sec-mark">${v.mark}</span><b>${esc(v.label)}</b><span class="sec-n">${fmt(n)}</span><span class="sec-help">${esc(v.help)}</span></div>`);
    }
    parts.push(secCard(r, open));
  }
  const more = list.length > shown.length ? `<button class="btn more-btn" id="secMore" type="button">Show ${fmt(Math.min(SEC_PAGE, list.length - shown.length))} more (${fmt(list.length - shown.length)} left)</button>` : '';
  $('#secList').innerHTML = `<p class="sec-count">${fmt(list.length)} ${list.length === 1 ? 'review' : 'reviews'}</p>
    <div class="sec-cards">${parts.join('') || '<div class="card" style="color:var(--muted)">Nothing matches.</div>'}</div>${more}`;
  const btn = $('#secMore');
  if (btn) btn.addEventListener('click', () => { sec.shown += SEC_PAGE; secList(open); });
}

function secBoxes(open) {
  const counts = Object.fromEntries(VERDICTS.map(v => [v.key, 0]));
  for (const r of sec.all) if (secInScope(r, open)) counts[r.verdict]++;
  const pending = counts['in-progress'];
  const checked = Object.values(counts).reduce((a, b) => a + b, 0) - pending;
  $('#secSay').innerHTML = `<b>${fmt(checked)}</b> pull ${checked === 1 ? 'request has' : 'requests have'} been security-checked so far${pending ? `, and ${fmt(pending)} more ${pending === 1 ? 'is' : 'are'} being reviewed` : ''}.`;
  $('#secBoxes').innerHTML = VERDICTS.map(v => `<button type="button" class="sec-box${sec.f.verdict === v.key ? ' on' : ''}${counts[v.key] ? '' : ' zero'}" data-v="${v.key}" aria-pressed="${sec.f.verdict === v.key}" style="--v:${v.color}" title="${esc(v.help)}">
      <b>${fmt(counts[v.key])}</b><span>${esc(v.box)}</span></button>`).join('');
  $('#secBoxes').querySelectorAll('.sec-box').forEach(b => b.addEventListener('click', () => {
    sec.f.verdict = sec.f.verdict === b.dataset.v ? '' : b.dataset.v;
    secRefresh();
  }));
}

/** Boxes and list again; the toolbar keeps its focus. A filter change starts the list at SEC_FIRST again. */
function secRefresh(reset = true) {
  if (reset) sec.shown = SEC_FIRST;
  const open = secOpenSet();
  sec.openAt = open ? pipe.fullAt : 0;
  secBoxes(open);
  secList(open);
}

function renderSecurity() {
  const box = $('#securityBody');
  if (!box) return;
  if (!sec.all.length) {
    if (sec.failed) box.innerHTML = `<div class="err-box"><b>Could not read the review table</b><br>${esc(sec.failed)}. It retries in a minute. The table itself: <a href="${SEC_REPO_URL}" target="_blank" rel="noopener">${esc(SEC_SOURCE)} ↗</a></div>`;
    return;
  }
  const open = secOpenSet();
  const f = sec.f;
  const reviewers = [...new Set(sec.all.map(r => r.reviewer))].sort((a, b) => a.localeCompare(b));
  if (f.reviewer && !reviewers.includes(f.reviewer)) f.reviewer = '';
  const hasAuto = sec.all.some(r => r.automated);
  box.innerHTML = `
    <p class="sec-say" id="secSay"></p>
    <div class="sec-boxes" id="secBoxes"></div>
    <p class="footnote sec-note">Tap a box to see those pull requests. <b>Clean</b> means nothing malicious was found in what was checked. It is not a promise that a PR is safe.</p>
    <div class="card sec-tools">
      <input id="secQ" type="search" placeholder="Find a PR: number, title, author or keyword" value="${esc(f.q)}" aria-label="Search security reviews">
      <div class="sec-row">
        <label class="sec-field">Checked by<select id="secWho"><option value="">anyone</option>${reviewers.map(n => `<option value="${esc(n)}"${n === f.reviewer ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
        <label class="sec-field">Order<select id="secOrder">${SEC_ORDERS.map(([k, l]) => `<option value="${k}"${k === f.order ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="sec-check"><input type="checkbox" id="secRemarks"${f.remarks ? ' checked' : ''}> With remarks only</label>
        ${hasAuto ? `<label class="sec-check"><input type="checkbox" id="secAuto"${f.hideAuto ? ' checked' : ''}> Hide automated scans</label>` : ''}
        ${open ? `<label class="sec-check"><input type="checkbox" id="secOpen"${f.openOnly ? ' checked' : ''}> Open PRs only</label>` : ''}
      </div>
    </div>
    <div id="secList"></div>
    <p class="footnote">Read from <a href="${SEC_REPO_URL}" target="_blank" rel="noopener">${esc(SEC_SOURCE)} ↗</a>, the table the reviewers share, every 15 minutes.${secOwnRepo() ? '' : ' Its numbers are pull requests of the original repository, which went private on 23 November; many of them carry on as <code>old-pr/&lt;number&gt;</code> branches.'} Every review there is a static reading of a PR's diff: nothing was run. Updated ${esc(ago(sec.at))}.${sec.failed ? ` The last refresh failed (${esc(sec.failed)}); this is the list from before.` : ''}</p>`;
  secRefresh(false);
  $('#secQ').addEventListener('input', e => { f.q = e.target.value; secRefresh(); });
  $('#secWho').addEventListener('change', e => { f.reviewer = e.target.value; secRefresh(); });
  $('#secOrder').addEventListener('change', e => { f.order = e.target.value; secRefresh(); });
  $('#secRemarks').addEventListener('change', e => { f.remarks = e.target.checked; secRefresh(); });
  const auto = $('#secAuto');
  if (auto) auto.addEventListener('change', e => { f.hideAuto = e.target.checked; secRefresh(); });
  const openBox = $('#secOpen');
  if (openBox) openBox.addEventListener('change', e => { f.openOnly = e.target.checked; secRefresh(); });
}

function startSecurity() {
  if (!$('#securityBody')) return;
  const saved = secUnpack(store.get(SEC_KEY));
  if (saved) {
    sec.all = saved.all;
    sec.at = saved.at;
    renderSecurity();
  }
  const due = () => !document.hidden && !sec.busy && Date.now() - sec.at >= (sec.failed ? SEC_TICK_MS : SEC_MS);
  if (due()) loadSecurity();
  setInterval(() => {
    if (due()) { loadSecurity(); return; }
    // Once the pipeline has (re)loaded the open PRs, redraw so the Open / Closed tags follow it.
    const open = secOpenSet();
    if (!sec.all.length || !open || pipe.fullAt === sec.openAt) return;
    if ($('#secOpen')) secRefresh(false); else renderSecurity();   // the "Open PRs only" box appears with the first list
  }, SEC_TICK_MS);
  document.addEventListener('visibilitychange', () => { if (due()) loadSecurity(); });
}
document.addEventListener('DOMContentLoaded', startSecurity);
