'use strict';
/*
 * The coordination issue in the format ubiquitarianism/leonida uses since the original repository went private: a
 * short "Open work" table in the issue body, and the claims as comments (`claiming: <ID> - what`, then
 * `done: <ID> -> #<PR>` once the pull request is open). This builds the same object parseCoordination returns for
 * the old format, so the blockers, the work board and triage read it unchanged.
 *
 * Cost: every comment once (100 a page), then only the comments since the last read (`since`), kept in
 * localStorage. The count of pull requests labeled `needs rebase` (their tools/pr_conflict_label.py) is one search.
 * Everything here is text other people wrote: it goes through plain() and esc() where it is shown.
 * Loaded after the inline script in index.html; uses api, store, searchQ, splitSections, findSection, parseTables,
 * rowToItem, catOfId, plain, CATS, REPO, STATUS_MS.
 */

const COORD2_KEY = 'coord2:v1';
const COORD2_PAGES = 30;                              // at most 3,000 comments in one read
const CLAIM_ID_RE = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g;
const CLAIM_TEXT_MAX = 240;
// New IDs are made up by whoever claims them (TOOL-BOOT-MATRIX, GPU-RTX5070-WIN); these prefixes join a known group.
const CAT_ALIAS = {
  DOC: 'PROC', DOCS: 'PROC', COORD: 'PROC', DASH: 'PROC', PR: 'PROC', GPU: 'TEST', VERIFY: 'TEST', TOOL: 'BUILD',
  TOOLS: 'BUILD', LOADER: 'RT', TRANSLATOR: 'SHADER', SEMANTIC: 'SHADER', VK: 'D3D', XDXR: 'D3D', VIEWER: 'ASSET',
  CI: 'BUILD', PE: 'RT', EXE: 'BOOT', BINDLESS: 'D3D', OGG: 'ASSET',
};
// Groups the page has no icon or label for yet; anything else unknown is shown under its prefix.
const NEW_GROUP_LABEL = { OLD: 'Old pull requests carried over' };

/** True for the new format: the body has an "Open work" section and no "Up for grabs" one. */
const isCoordV2 = body => /^##\s+Open work\b/mi.test(body || '') && !/^#+\s+Up for grabs/mi.test(body || '');

/** A claim or done comment, trimmed for storage; null for every other comment. */
function pickClaimComment(c) {
  const body = typeof c.body === 'string' ? c.body.trim() : '';
  if (!/^(claiming|done):/i.test(body)) return null;
  return { c: c.id, u: (c.user && c.user.login) || '', t: c.created_at || '', b: body.slice(0, 1200) };
}

const claimHead = line => line.split(/\s[-–—]\s|:\s|\s\(/)[0];

/** The IDs at the start of a claim: before the first " - ", " — ", ": " or " (" that follows them. */
function leadingIds(line) {
  return claimHead(line).match(CLAIM_ID_RE) || [];
}

/** { id: { ID, Owner, What, PR, Status, at } } from the comments, oldest first; the first claim of an ID owns it. */
function claimsFromComments(events) {
  const items = new Map();
  for (const e of [...events].sort((a, b) => String(a.t).localeCompare(String(b.t)))) {
    const text = e.b.replace(/\r/g, '');
    const done = text.match(/^done:\s*([^\n]+?)\s*->\s*#(\d+)/i);
    if (done) {
      for (const id of leadingIds(done[1])) {
        const it = items.get(id) || { ID: id, Owner: e.u, What: '', at: e.t };
        items.set(id, { ...it, PR: '#' + done[2], Status: 'PR #' + done[2] });
      }
      continue;
    }
    const lines = text.replace(/^claiming:\s*/i, '').split('\n');
    const first = lines[0];
    const ids = [...leadingIds(first), ...lines.slice(1).filter(l => /^\s*[-*]\s+/.test(l)).flatMap(l => leadingIds(l.replace(/^\s*[-*]\s+/, '')))];
    const what = plain(first.slice(claimHead(first).length).replace(/^\s*[-–—:]\s*/, '')).slice(0, CLAIM_TEXT_MAX);
    for (const id of ids) {
      if (items.has(id)) continue;
      items.set(id, { ID: id, Owner: e.u, What: what, PR: '', Status: 'claimed', at: e.t });
    }
  }
  return items;
}

/** The claim and done comments of issue `no`: all of them the first time, then those since the last read. */
async function coordClaimEvents(no) {
  const saved = store.get(COORD2_KEY);
  const known = saved && saved.no === no && Array.isArray(saved.events) ? saved : { no, at: 0, events: [] };
  const since = known.at ? '&since=' + encodeURIComponent(new Date(known.at - 5 * 60 * 1000).toISOString()) : '';
  const started = Date.now();
  const byId = new Map(known.events.map(e => [e.c, e]));
  try {
    for (let page = 1; page <= COORD2_PAGES; page++) {
      const r = await api(`/repos/${REPO}/issues/${no}/comments?per_page=100&page=${page}${since}`,
        d => (Array.isArray(d) ? d : []).map(pickClaimComment).filter(Boolean), 'coord2:page');
      for (const e of r.data) byId.set(e.c, e);
      if (r.stale || !/rel="next"/.test(r.link || '')) break;
    }
  } catch (e) {
    if (!byId.size) throw e;
    console.warn('[dashboard] coordination comments: using the saved claims', e);
    return known.events;
  }
  const events = [...byId.values()];
  store.set(COORD2_KEY, { no, at: started, events });
  return events;
}

/** Open pull requests labeled `needs rebase`: the count and who they belong to. */
async function rebaseLabeled() {
  const r = await api(searchQ('is:pr is:open label:"needs rebase"') + '&per_page=100',
    d => ({ total: d.total_count, items: (d.items || []).map(i => ({ n: i.number, u: (i.user && i.user.login) || '' })) }),
    'coord2:rebase', { maxAge: STATUS_MS });
  const byUser = new Map();
  for (const i of r.data.items) byUser.set(i.u, [...(byUser.get(i.u) || []), String(i.n)]);
  const rebaseBy = [...byUser].map(([user, prs]) => ({ user, prs })).sort((a, b) => b.prs.length - a.prs.length);
  return { rebase: r.data.total, rebaseBy };
}

const catKeyFor = id => {
  const known = catOfId(id);
  if (known) return known.key;
  const prefix = id.split('-')[0];
  return CAT_ALIAS[prefix] || prefix;
};

/** The same shape as parseCoordination(body), from the new-format issue and its comments. */
async function loadCoordinationV2(issue) {
  const [eventsR, rebaseR] = await Promise.allSettled([coordClaimEvents(issue.number), rebaseLabeled()]);
  const secs = splitSections(issue.body, 2);
  const table = parseTables(findSection(secs, /^open work/i))[0] || [];
  const grabs = table.map(r => {
    const id = plain(r.ID || '').replace(/`/g, '').trim();
    const status = plain(r.Status || '');
    const pr = (status.match(/#(\d+)/) || [])[1];
    const row = { ID: id, What: r.What || '', Needs: r.Needs || '', Status: status, PR: pr && /\bPR\b|draft/i.test(status) ? '#' + pr : '' };
    return rowToItem(row, catKeyFor(id), row.PR ? 'pr' : 'grab');
  }).filter(it => it.id);

  const claims = eventsR.status === 'fulfilled' ? claimsFromComments(eventsR.value) : new Map();
  if (eventsR.status === 'rejected') console.error('[dashboard] coordination comments', eventsR.reason);
  const groups = new Map();
  for (const row of claims.values()) {
    const key = catKeyFor(row.ID);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const categories = [...groups].map(([key, rows]) => ({
    key,
    label: (CATS.find(c => c.key === key) || {}).label || NEW_GROUP_LABEL[key] || key,
    rows, plusPr: 0, done: [], tracker: null, inProgress: null,
  }));
  const rebase = rebaseR.status === 'fulfilled' ? rebaseR.value : { rebase: 0, rebaseBy: [] };
  if (rebaseR.status === 'rejected') console.warn('[dashboard] needs-rebase count', rebaseR.reason);
  return {
    updated: issue.updated_at ? new Date(issue.updated_at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '',
    grabs, blocked: [], review: [], reviewPrs: {},
    rebase: rebase.rebase, rebaseBy: rebase.rebaseBy,
    stale: [], decisions: [], chains: [], hotspots: 0,
    categories, d3dTracker: null,
    format: 'v2',
  };
}
