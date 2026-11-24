/* Merged pull requests of the last 24 hours, for the activity chart (merged and opened per clock hour) and the
 * "most merged" list.
 *
 * The page keeps every merged PR of the last day in the browser as [mergedAt, createdAt, user, avatar] and the time
 * span it knows completely, [from, until]. GitHub search fills the span once: the newest 6 hours first, then 6 hours
 * further back at a time, 100 PRs per call. After that the live feed (one search a minute, which the page makes
 * anyway) brings in every new merge and moves `until` forward, so the chart costs no further calls. A visitor coming
 * back after a while only fetches the gap since their last visit.
 * "Opened" per hour is counted from data the page already has: the open PRs of the pipeline and the merged ones here.
 * PRs closed without merging are not in either, so it is a slight undercount.
 * Loaded after live.js; uses api, searchQ, store, rate, blockedUntil, activeToken, iso, pipe (at run time). */
'use strict';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HOURS_SHOWN = 24;
const CHUNK_MS = 6 * HOUR_MS;           // one backward step of the first fill
const RANGE_PAGE = 100;
const RANGE_MAX_PAGES = 10;             // 1,000 merges in one range at most
const FEED_FRESH_MS = 3 * 60 * 1000;    // `until` older than this: the feed did not keep up, fetch the gap
const GAP_OVERLAP_MS = 2 * 60 * 1000;
const SEARCH_RESERVE = 1;               // keep one search call for a manual refresh
const MERGED_KEY = 'merged:v1';
const MERGED_JOB_KEY = 'merged:job';
const MERGED_JOB_KEEP_MS = 10 * 60 * 1000;   // a range interrupted by F5 goes on if it is younger than this
const SEARCH_LIMIT_GUESS = { token: 30, none: 10 };

const mergedStore = (() => {
  const saved = store.get(MERGED_KEY);
  const ok = saved && saved.items && typeof saved.items === 'object';
  return ok ? { items: saved.items, from: saved.from || 0, until: saved.until || 0 } : { items: {}, from: 0, until: 0 };
})();
// A range being fetched across syncs, saved so an F5 in the middle goes on from its page: { kind, a, b, page, startedAt }
let mergedJob = (() => {
  const job = store.get(MERGED_JOB_KEY);
  return job && Date.now() - (job.startedAt || 0) < MERGED_JOB_KEEP_MS ? job : null;
})();

function saveMerged() {
  store.set(MERGED_KEY, mergedStore);
  if (mergedJob) store.set(MERGED_JOB_KEY, mergedJob);
  else store.del(MERGED_JOB_KEY);
}

/** Search calls this window still allows, minus the reserve. */
function searchBudget() {
  if ((blockedUntil.search || 0) > Date.now()) return 0;
  const r = rate.search;
  const left = r && r.reset > Date.now() ? r.remaining : (activeToken() ? SEARCH_LIMIT_GUESS.token : SEARCH_LIMIT_GUESS.none);
  return left - SEARCH_RESERVE;
}

/** When the search limit allows calls again. */
function searchResetAt() {
  const r = rate.search;
  const reset = r && r.reset > Date.now() ? r.reset : Date.now() + 60000;
  return Math.max(blockedUntil.search || 0, reset);
}

function keepMerged(n, mergedAt, createdAt, user, avatar, title) {
  if (!mergedAt) return;
  mergedStore.items[n] = [Date.parse(mergedAt), Date.parse(createdAt), user, avatar, title || ''];
}

/** PRs merged in the last `windowMs`, newest first, for the pipeline's "Merged" column. */
function recentMerged(windowMs, now = Date.now()) {
  return Object.entries(mergedStore.items)
    .filter(([, row]) => now - row[0] < windowMs)
    .map(([n, [mergedAt, createdAt, user, avatar, title]]) => ({ n: Number(n), mergedAt, createdAt, user, avatar, title: title || '' }))
    .sort((a, b) => b.mergedAt - a.mergedAt);
}

/**
 * The live feed's PRs for one window [from, until]. When that window joins the span already known, the span grows to
 * `until`: the feed is what keeps the chart current. A feed that was too busy to be complete does not count.
 */
function mergedFromFeed(items, from, until, complete) {
  for (const it of items) if (it.pr && it.merged) keepMerged(it.n, it.merged, it.created, it.user, it.avatar, it.title);
  if (complete && mergedStore.until && mergedStore.until >= from && until > mergedStore.until) mergedStore.until = until;
  saveMerged();
}

async function fetchMergedPage(a, b, page) {
  const r = await api(searchQ(`is:pr is:merged merged:${iso(a)}..${iso(b)}`) + `&sort=created&order=asc&per_page=${RANGE_PAGE}&page=${page}`,
    d => ({
      total: d.total_count,
      items: (d.items || []).map(i => [i.number, i.pull_request && i.pull_request.merged_at, i.created_at, i.user ? i.user.login : '', i.user ? i.user.avatar_url : '', i.title]),
    }), 'merged:tmp');
  if (r.stale) throw new Error('GitHub did not answer the merged-PR search');
  return r.data;
}

/** The next range to fetch, or null when the last 24 hours are known completely. */
function nextMergedJob(now) {
  const target = now - DAY_MS;
  if (!mergedStore.until) return { kind: 'first', a: Math.max(target, now - CHUNK_MS), b: now, page: 1, startedAt: now };
  if (now - mergedStore.until > FEED_FRESH_MS) return { kind: 'gap', a: mergedStore.until - GAP_OVERLAP_MS, b: now, page: 1, startedAt: now };
  if (mergedStore.from > target) return { kind: 'back', a: Math.max(target, mergedStore.from - CHUNK_MS), b: mergedStore.from, page: 1, startedAt: now };
  return null;
}

/**
 * Fill the span within the search budget. Returns { changed, waiting }: whether new data came in, and whether a
 * range still waits for the search limit.
 */
async function loadMerged() {
  const now = Date.now();
  const target = now - DAY_MS;
  for (const [n, row] of Object.entries(mergedStore.items)) if (row[0] < target - HOUR_MS) delete mergedStore.items[n];
  if (mergedStore.from && mergedStore.from < target) mergedStore.from = target;
  let changed = false;
  while (true) {
    if (!mergedJob) mergedJob = nextMergedJob(Date.now());
    if (!mergedJob) break;
    if (searchBudget() < 1) return { changed, waiting: true };
    const job = mergedJob;
    let data;
    try {
      data = await fetchMergedPage(job.a, job.b, job.page);
    } catch (e) {
      console.warn('[dashboard] merged PRs: starting this range over next time', e);
      mergedJob = null;
      saveMerged();
      return { changed, waiting: false, error: e };
    }
    for (const [n, mergedAt, createdAt, user, avatar, title] of data.items) keepMerged(n, mergedAt, createdAt, user, avatar, title);
    changed = true;
    const pages = Math.min(RANGE_MAX_PAGES, Math.ceil(data.total / RANGE_PAGE));
    if (job.page < pages) { job.page++; saveMerged(); continue; }
    // The range is complete: grow the span.
    if (job.kind === 'first') { mergedStore.from = job.a; mergedStore.until = job.startedAt; }
    else if (job.kind === 'gap') mergedStore.until = job.startedAt;
    else mergedStore.from = job.a;
    mergedJob = null;
    saveMerged();
  }
  if (changed) saveMerged();
  return { changed, waiting: false };
}

/** How many of the last 24 hours are known, for the progress line. */
function mergedProgress(now = Date.now()) {
  if (!mergedStore.until) return { hours: 0, of: HOURS_SHOWN, complete: false };
  const from = Math.max(mergedStore.from, now - DAY_MS);
  const hours = Math.max(0, Math.min(HOURS_SHOWN, Math.floor((mergedStore.until - from) / HOUR_MS)));
  const complete = mergedStore.from <= now - DAY_MS + 60000 && now - mergedStore.until <= FEED_FRESH_MS;
  return { hours: complete ? HOURS_SHOWN : hours, of: HOURS_SHOWN, complete };
}

function hourStarts(now) {
  const current = Math.floor(now / HOUR_MS) * HOUR_MS;
  return Array.from({ length: HOURS_SHOWN }, (_, i) => current - (HOURS_SHOWN - 1 - i) * HOUR_MS);
}

/** The 24 hours for the chart, the authors of the merges known so far, and the 24-hour merge count when complete. */
function hourSeries(now = Date.now()) {
  const rows = Object.values(mergedStore.items);
  const open = typeof pipe !== 'undefined' && pipe.fullAt ? [...pipe.prs.values()].map(p => Date.parse(p.created)) : null;
  const series = hourStarts(now).map(start => {
    const end = start + HOUR_MS;
    const known = mergedStore.until > 0 && mergedStore.from <= start && (mergedStore.until >= end || now - mergedStore.until <= FEED_FRESH_MS);
    const merged = rows.filter(r => r[0] >= start && r[0] < end).length;
    const opened = open ? rows.filter(r => r[1] >= start && r[1] < end).length + open.filter(t => t >= start && t < end).length : 0;
    return { start, known, merged, opened, openedKnown: !!open };
  });
  const people = {};
  for (const [mergedAt, , user, avatar] of rows) {
    if (mergedAt < now - DAY_MS || !user) continue;
    people[user] = people[user] || { user, avatar, n: 0 };
    people[user].n++;
  }
  const progress = mergedProgress(now);
  return {
    series,
    known: series.filter(h => h.known).length,
    people: Object.values(people).sort((a, b) => b.n - a.n),
    merged24: progress.complete ? rows.filter(r => r[0] >= now - DAY_MS).length : null,
  };
}
