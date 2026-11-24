'use strict';
/*
 * "Alive forks", under the ring: the forks of the repository the page follows (HOME_REPO, or the root of its fork
 * network) that are still moving: pushed in the last ALIVE_DAYS days and holding commits of their own that its
 * BASE_BRANCH does not have. Picking one reloads the page with ?repo= for it.
 *
 * Cost: the network root (one call, cached SLOW_MS), two fork listings, then one compare per candidate and one list
 * of closed PRs per fork that is ahead. Per-fork results are kept in localStorage keyed by the fork's last push, so a
 * fork that has not pushed since is never asked again. Without a token the candidates are capped and every call
 * first checks coreSpare(), so the rest of the page keeps its hourly allowance.
 * Loaded after the inline script in index.html and live.js; uses $, esc, fmt, ago, api, store, scrub, coreSpare,
 * activeToken, REPO, BRANCH, HOME_REPO.
 */

const BASE_BRANCH = 'main';                // the root's branch a fork's own commits are counted against
// A fork's numbers are kept until it pushes again, or this long: its commits leave the count once they are merged.
const FORK_REMEASURE_MS = 6 * 60 * 60 * 1000;
// Forks whose work was screened and merged into HOME_REPO by hand, with the fork commit it was merged up to.
const MERGED_INTO_HOME = {};
const ALIVE_DAYS = 7;
const FORKS_SHOWN = 10;
const FORK_CANDIDATES = { token: 40, anon: 15 };
const FORKS_MS = 30 * 60 * 1000;          // the listing is redone every 30 minutes
const FORKS_TICK_MS = 60 * 1000;
const FORKS_KEY = 'forks:v2';           // v2: counted against the root's live main
const PUSH_GRACE_MS = 2 * 60 * 1000;       // a fork pushed within this of its creation never pushed anything itself
const FORK_DAY_MS = 24 * 60 * 60 * 1000;
const FULL_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const forks = { list: [], known: {}, at: 0, busy: false, failed: '', partial: false };

/** A fork from the listing, or null when it is unusable or its name would need masking. */
function forkEntry(f) {
  if (!f || typeof f.full_name !== 'string' || !FULL_RE.test(f.full_name)) return null;
  if (scrub(f.full_name) !== f.full_name) return null;
  const branch = typeof f.default_branch === 'string' && BRANCH_RE.test(f.default_branch) ? f.default_branch : 'main';
  const pushed = Date.parse(f.pushed_at);
  const created = Date.parse(f.created_at);
  if (!Number.isFinite(pushed) || !Number.isFinite(created)) return null;
  return { full: f.full_name, owner: f.full_name.split('/')[0], branch, pushed, created, stars: Number(f.stargazers_count) || 0 };
}

const pickForks = d => (Array.isArray(d) ? d : []).map(f => ({
  full_name: f.full_name, default_branch: f.default_branch, pushed_at: f.pushed_at, created_at: f.created_at,
  stargazers_count: f.stargazers_count,
}));

/** The root of the fork network: the source of the home repository (it moved once already). */
async function forkRoot() {
  const r = await api(`/repos/${HOME_REPO}`, d => ({ source: d.source && d.source.full_name, full: d.full_name }), 'forks:home', { maxAge: SLOW_MS });
  const root = r.data.source || r.data.full;
  if (!FULL_RE.test(root || '')) throw new Error('GitHub did not name the fork network');
  return root;
}

/** Forks pushed recently, newest push first, without our home repository. */
async function forkCandidates(root) {
  const seen = new Map();
  for (const sort of ['stargazers', 'newest']) {
    const r = await api(`/repos/${root}/forks?sort=${sort}&per_page=100`, pickForks, 'forks:list:' + sort, { maxAge: FORKS_MS });
    for (const raw of r.data) {
      const f = forkEntry(raw);
      if (f && f.full !== HOME_REPO) seen.set(f.full, f);
    }
  }
  const since = Date.now() - ALIVE_DAYS * FORK_DAY_MS;
  const cap = activeToken() ? FORK_CANDIDATES.token : FORK_CANDIDATES.anon;
  return [...seen.values()]
    .filter(f => f.pushed >= since && f.pushed - f.created > PUSH_GRACE_MS)
    .sort((a, b) => b.pushed - a.pushed)
    .slice(0, cap);
}

/** Commits of its own that the root's BASE_BRANCH lacks, and merged PRs from people other than the owner. */
async function forkMeasure(root, f) {
  const cmp = await api(`/repos/${root}/compare/${BASE_BRANCH}...${f.owner}:${encodeURIComponent(f.branch)}?per_page=1`,
    d => ({ ahead: Number(d.ahead_by) || 0, behind: Number(d.behind_by) || 0 }), 'forks:cmp');
  const m = { pushed: f.pushed, at: Date.now(), ahead: cmp.data.ahead, behind: cmp.data.behind, outside: 0, people: 0 };
  if (!m.ahead) return m;
  try {
    const prs = await api(`/repos/${f.full}/pulls?state=closed&per_page=100`,
      d => (Array.isArray(d) ? d : []).filter(p => p.merged_at && p.user && p.user.login !== f.owner).map(p => p.user.login), 'forks:prs');
    m.outside = prs.data.length;
    m.people = new Set(prs.data).size;
  } catch (e) {
    console.warn('[dashboard] fork pull requests', f.full, e);   // pull requests switched off: the fork still counts
  }
  return m;
}

async function loadForks() {
  if (forks.busy) return;
  forks.busy = true;
  try {
    const root = await forkRoot();
    forks.root = root;
    const candidates = await forkCandidates(root);
    forks.partial = false;
    for (const f of candidates) {
      const known = forks.known[f.full];
      if (known && known.pushed === f.pushed && Date.now() - (known.at || 0) < FORK_REMEASURE_MS) continue;
      if (!coreSpare()) { forks.partial = true; break; }
      try {
        forks.known[f.full] = await forkMeasure(root, f);
      } catch (e) {
        // Out of hourly allowance: stop here and say so, instead of listing the forks as having nothing of their own.
        if (e instanceof RateLimitError) { forks.partial = true; break; }
        console.warn('[dashboard] fork', f.full, e);   // a fork with its default branch gone answers 404: skip it
      }
    }
    forks.list = candidates.map(f => ({ ...f, ...(forks.known[f.full] || {}) }))
      .filter(f => f.ahead > 0)
      .sort((a, b) => (b.people > 0) - (a.people > 0) || b.ahead - a.ahead || b.pushed - a.pushed);
    forks.at = Date.now();
    forks.failed = '';
    const keep = Object.fromEntries(candidates.filter(f => forks.known[f.full]).map(f => [f.full, forks.known[f.full]]));
    store.set(FORKS_KEY, { at: forks.at, known: keep, list: forks.list });
  } catch (e) {
    console.error('[dashboard] forks', e);
    forks.failed = e.message;
  } finally {
    forks.busy = false;
    renderForks();
  }
}

const forkHref = (full, branch) => `?repo=${encodeURIComponent(full)}&branch=${encodeURIComponent(branch)}`;

function forkRow(f) {
  const on = f.full === REPO;
  const others = f.people
    ? `<span class="fk-tag good">${fmt(f.outside)} merged ${f.outside === 1 ? 'PR' : 'PRs'} from ${fmt(f.people)} ${f.people === 1 ? 'other' : 'others'}</span>`
    : '';
  const merged = MERGED_INTO_HOME[f.full];
  const mergedTag = merged
    ? `<span class="fk-tag good" title="Screened and merged into ${esc(HOME_REPO)} up to ${esc(merged.upTo)}: ${esc(merged.note)}">merged into ours</span>`
    : '';
  return `<a class="fk-row${on ? ' on' : ''}" href="${forkHref(f.full, f.branch)}"${on ? ' aria-current="page"' : ''}>
    <span class="fk-name">${esc(f.full)}</span>
    <span class="fk-meta"><span>+${fmt(f.ahead)} own ${f.ahead === 1 ? 'commit' : 'commits'}</span>${mergedTag}${others}<span>pushed ${esc(ago(f.pushed))}</span>${f.stars ? `<span>★ ${fmt(f.stars)}</span>` : ''}</span>
  </a>`;
}

function renderForks() {
  const box = $('#forks');
  if (!box) return;
  const shown = forks.list.slice(0, FORKS_SHOWN);
  const home = REPO === HOME_REPO
    ? ''
    : `<p class="fk-now">Showing <b>${esc(REPO)}</b>. <a href="?">Back to ${esc(HOME_REPO)}</a></p>`;
  let body;
  if (shown.length) body = `<div class="fk-list">${shown.map(forkRow).join('')}</div>`;
  else if (forks.failed) body = `<p class="fk-empty">Could not list the forks (${esc(forks.failed)}). It retries in a minute.</p>`;
  else if (forks.partial) body = '<p class="fk-empty">Waiting for the hourly GitHub allowance to measure the forks; a free token does it at once.</p>';
  else if (forks.at) body = `<p class="fk-empty">No fork pushed commits of its own in the last ${ALIVE_DAYS} days.</p>`;
  else body = '<p class="fk-empty">Looking for forks that are still moving…</p>';
  const more = forks.partial ? ' Some forks wait for the hourly GitHub allowance; a free token measures all of them.' : '';
  box.innerHTML = `<div class="fk-head"><b>Alive forks</b><span>${forks.at ? 'checked ' + esc(ago(forks.at)) : ''}</span></div>
    <p class="fk-lede">Forks of ${esc(forks.root || HOME_REPO)} with work of their own: pushed in the last ${ALIVE_DAYS} days, with commits its ${esc(BASE_BRANCH)} does not have yet. Pick one to see this page for it.</p>
    ${home}${body}
    <p class="fk-note">Forks with merged pull requests from other people come first, then the most commits of their own.${more}</p>`;
}

function startForks() {
  if (!$('#forks')) return;
  const saved = store.get(FORKS_KEY);
  if (saved && Number.isFinite(saved.at) && saved.known && typeof saved.known === 'object' && Array.isArray(saved.list)) {
    forks.known = saved.known;
    forks.list = saved.list.filter(f => f && FULL_RE.test(f.full || '') && BRANCH_RE.test(f.branch || ''));
    forks.at = saved.at;
  }
  renderForks();
  const due = () => !document.hidden && !forks.busy && Date.now() - forks.at >= (forks.failed || forks.partial ? FORKS_TICK_MS : FORKS_MS);
  if (due()) loadForks();
  setInterval(() => { if (due()) loadForks(); else renderForks(); }, FORKS_TICK_MS);
  document.addEventListener('visibilitychange', () => { if (due()) loadForks(); });
}
document.addEventListener('DOMContentLoaded', startForks);
