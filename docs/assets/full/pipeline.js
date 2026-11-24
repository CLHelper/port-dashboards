/* The PR pipeline: every open pull request as one dot in the column of the stage it is at.
 *
 * Stages come from GitHub search (draft, CI passing, CI failing) and the coordination issue (needs a rebase, CI
 * running, checked by someone else). A dot that changes stage slides to its new column and pulses; a merge seen by
 * the live feed flies the dot into the `main` lane, where it disappears; a new PR pops in; a closed one fades out.
 * Nothing moves on first paint. Hover or focus a dot for the PR, click to open it.
 *
 * Cost, all from what the search limit has left after the live feed:
 * - a full load (one call per 100 open PRs plus the two CI sets) on the first visit and every 30 minutes;
 * - the two CI sets alone every 5 minutes (every minute with a token): CI results are the one thing the feed can't see;
 * - nothing else: the feed's one search a minute brings opened, merged, closed, draft and comment changes.
 * The last load is kept in the browser and shows at once on the next visit.
 * Loaded after live.js and activity.js; uses api, searchQ, store, esc, ago, fmt, $, searchBudget, activeToken,
 * latestCoord, live and the queue/renderQueue of live.js. */
'use strict';

const PIPE_CI_MS_NO_TOKEN = 5 * 60 * 1000;
const PIPE_CI_MS_TOKEN = 60 * 1000;
const PIPE_FULL_MS = 30 * 60 * 1000;
const PIPE_PAGE = 100;
const PIPE_WINDOW_PAGES = 10;             // search answers at most 1,000 results: past that, a new search starts at the last PR's date
const PIPE_KEY = 'pipe:v2';
const PIPE_JOB_KEY = 'pipe:job';
const JOB_KEEP_MS = 10 * 60 * 1000;      // a load interrupted by F5 goes on if it is younger than this
const DOT = 10;
const PITCH = 13;
const COL_MIN_W = 96;
const COL_GAP = 10;
const MAIN_W = 76;
const HEAD_H = 62;
const PAD = 10;
const FLY_MS = 1300;
const PING_MS = 2400;
const MERGE_STAGGER_MS = 160;
const ROUND_MIN_SHOW = 5;
const ROUND_HOLD_MS = 3500;
const RECENT_MERGED_MS = 2 * 60 * 60 * 1000;   // the Merged column behind main: the last two hours, about two rounds
const MERGED_COL = { key: 'merged', label: 'Merged', color: '#c084fc', hint: 'last 2 hours' };
const LAND_RENDER_MS = 250;                    // after a flight lands, redraw once (a round lands many at a time)

const PIPE_STAGES = [
  { key: 'draft', label: 'Draft', color: '#6f6790', hint: 'not ready yet' },
  { key: 'waiting', label: 'Waiting for CI', color: '#ffb648', hint: 'first run needs a maintainer' },
  { key: 'running', label: 'CI running', color: '#ffd166', hint: 'checks in progress' },
  { key: 'failing', label: 'CI failing', color: '#ff4d6d', hint: 'needs a fix', work: true },
  { key: 'rebase', label: 'Needs rebase', color: '#ff3d8b', hint: 'conflicts with main', work: true },
  { key: 'green', label: 'CI green', color: '#2ee6c8', hint: 'nobody checked it yet' },
  { key: 'ready', label: 'Ready', color: '#9dff7a', hint: 'green and checked' },
];
const STAGE_INDEX = Object.fromEntries(PIPE_STAGES.map((s, i) => [s.key, i]));

const pipe = {
  prs: new Map(),       // n → { n, title, user, avatar, url, created, draft, comments, stage, checked, ciRunning, group, item }
  ok: { total: 0, items: [] },    // open PRs with passing CI (for the stages and the merge queue lists)
  bad: { total: 0, items: [] },   // open PRs with failing CI
  fullAt: 0,            // when the last full load finished
  ciAt: 0,              // when the CI sets were last loaded
  job: null,            // a load in progress across syncs: { full, ok, bad, items, total, page }
  els: new Map(),       // n → the dot element
  mels: new Map(),      // n → a dot in the Merged column
  width: 0,
  target: null,         // () → where a merged dot flies to in the main lane, for the current layout
  mergedRecently: [],   // timestamps of merges flown into main this session
  round: null,
  ready: false,         // drawn once; later changes animate
  live: false,          // the feed has been applied once since the page opened; later merges fly
};

const pipeInterval = () => (activeToken() ? PIPE_CI_MS_TOKEN : PIPE_CI_MS_NO_TOKEN);

/* ================= data ================= */
const pickPipeList = d => ({
  total: d.total_count,
  items: (d.items || []).map(i => ({
    n: i.number, title: i.title, user: i.user ? i.user.login : '', avatar: i.user ? i.user.avatar_url : '',
    url: i.html_url, created: i.created_at, draft: !!i.draft, comments: i.comments || 0,
    tids: refIds(i.title), ...bodyRefs(i.body),
  })),
});

/** `conflict` is GitHub's live merge state from a token's sweep; without it the coordination issue's rebase list. */
function stageOf(pr, ok, bad, rebase) {
  if (pr.draft) return 'draft';
  if (pr.conflict === true || (pr.conflict == null && rebase.has(pr.n))) return 'rebase';
  if (bad.has(pr.n)) return 'failing';
  if (ok.has(pr.n)) return pr.checked ? 'ready' : 'green';
  if (pr.ciRunning) return 'running';
  return 'waiting';
}

/** Calls a load still needs, for the progress line: null when nothing is due. */
function pipelineNeeds() {
  if (graph.busy) return { done: graph.busy.done, total: graph.busy.total, full: true };
  const job = pipe.job;
  if (!job) return null;
  const pages = job.full ? (job.total === null ? 5 : Math.ceil(job.total / PIPE_PAGE)) : 0;
  const total = 2 + pages;
  const done = (job.ok ? 1 : 0) + (job.bad ? 1 : 0) + (job.full ? Math.ceil(job.items.length / PIPE_PAGE) : 0);
  return { done: Math.min(done, total), total, full: job.full };
}

/** One call of a load; null when the search budget ran out (the load goes on at the next sync). */
async function pipeCall(path, key) {
  if (searchBudget() < 1) return null;
  const r = await api(path, pickPipeList, key);
  if (r.stale) throw new Error('GitHub did not answer the pipeline search');
  return r.data;
}

/**
 * Start or go on with a load: a full one when there is none or it is PIPE_FULL_MS old, else only the CI sets when they
 * are due. Returns 'done', 'waiting' (budget ran out, goes on later), 'idle' or 'error'.
 */
async function loadPipeline(now) {
  if (graphCovers()) { pipe.job = null; return 'idle'; }   // the token's sweep (triage.js) brings all of this
  if (!pipe.job) {
    if (!pipe.fullAt || now - pipe.fullAt >= PIPE_FULL_MS) pipe.job = { full: true, ok: null, bad: null, items: [], total: null, page: 1, startedAt: now };
    else if (now - pipe.ciAt >= pipeInterval()) pipe.job = { full: false, ok: null, bad: null, startedAt: now };
    else return 'idle';
  }
  const job = pipe.job;
  const set = q => searchQ(`is:pr is:open ${q}`) + `&sort=created&order=asc&per_page=${PIPE_PAGE}`;
  try {
    // Each step is saved, so an F5 in the middle goes on from here instead of starting over.
    if (!job.ok && !(job.ok = await pipeCall(set('status:success'), 'pipe:ok'))) return 'waiting';
    store.set(PIPE_JOB_KEY, job);
    if (!job.bad && !(job.bad = await pipeCall(set('status:failure'), 'pipe:bad'))) return 'waiting';
    store.set(PIPE_JOB_KEY, job);
    while (job.full && !job.listed) {
      if (!await pipeListPage(job)) return 'waiting';
      store.set(PIPE_JOB_KEY, job);
    }
  } catch (e) {
    console.error('[dashboard] pipeline load failed; starting over next time', e);
    pipe.job = null;
    store.del(PIPE_JOB_KEY);
    return 'error';
  }
  pipe.job = null;
  store.del(PIPE_JOB_KEY);
  pipe.ok = job.ok;
  pipe.bad = job.bad;
  pipe.ciAt = Date.now();
  if (job.full) applySnapshot(job.items);
  else restagePipeline();
  return 'done';
}

/**
 * One page of the open PR list, oldest first. Search stops at 1,000 results, so after PIPE_WINDOW_PAGES pages the next
 * search starts at the last PR's creation date (`since`); the overlap is dropped. Sets `listed` when the list is
 * complete. Returns false when the search budget ran out.
 */
async function pipeListPage(job) {
  const range = job.since ? ` created:>=${job.since}` : '';
  const page = await pipeCall(searchQ('is:pr is:open' + range) + `&sort=created&order=asc&per_page=${PIPE_PAGE}&page=${job.page}`, 'pipe:list');
  if (!page) return false;
  if (!job.since) job.total = page.total;
  const have = new Set(job.items.map(p => p.n));
  const fresh = page.items.filter(p => !have.has(p.n));
  job.items.push(...fresh);
  job.page++;
  const last = page.items[page.items.length - 1];
  if (page.items.length < PIPE_PAGE || job.items.length >= job.total) job.listed = true;
  else if (job.page > PIPE_WINDOW_PAGES) {
    if (!fresh.length) job.listed = true;   // a whole page on one date: a new window would repeat it forever
    else { job.since = last.created; job.page = 1; }
  }
  return true;
}

function coordSets() {
  const coord = latestCoord;
  return {
    rebase: new Set((coord ? coord.rebaseBy : []).flatMap(a => a.prs.map(Number))),
    review: coord ? coord.reviewPrs : {},
  };
}

function withCoord(item, review) {
  const r = review[item.n] || {};
  return { ...item, checked: r.checked || 0, ciRunning: !!r.ciRunning, group: r.group || '', item: r.item || '' };
}

/** A token's GraphQL sweep (triage.js): every open PR with its CI result and merge state, in place of the searches. */
function applyGraph(items) {
  const slim = p => ({ n: p.n, title: p.title, user: p.user, avatar: p.avatar, url: p.url, created: p.created, draft: p.draft, comments: p.comments });
  const ok = items.filter(p => p.ci === 'ok').map(slim);
  const bad = items.filter(p => p.ci === 'bad').map(slim);
  pipe.ok = { total: ok.length, items: ok };
  pipe.bad = { total: bad.length, items: bad };
  pipe.ciAt = Date.now();
  applySnapshot(items);
}

/** A full load: the open PR list replaces what the page had. */
function applySnapshot(items) {
  const { rebase, review } = coordSets();
  const ok = new Set(pipe.ok.items.map(p => p.n));
  const bad = new Set(pipe.bad.items.map(p => p.n));
  const next = new Map();
  for (const item of items) {
    if (next.has(item.n)) continue;   // paging while PRs open and merge can repeat one
    const pr = withCoord(item, review);
    pr.stage = stageOf(pr, ok, bad, rebase);
    next.set(item.n, pr);
  }
  const gone = [...pipe.prs.keys()].filter(n => !next.has(n));
  const changed = changedPrs(next);
  pipe.prs = next;
  pipe.fullAt = Date.now();
  savePipeline();
  queueFromPipeline();
  // Gone since the last load: merged ones fly to main once the page is live, the rest fade.
  gone.forEach((n, i) => (pipe.live && live.keys.has('merged:' + n) ? setTimeout(() => flyToMain(n), i * MERGE_STAGGER_MS) : fadeOut(n)));
  renderPipeline(changed);
}

/** New CI sets or a new coordination issue: work out every PR's stage again, no calls. */
function restagePipeline() {
  if (!pipe.prs.size) return;
  const { rebase, review } = coordSets();
  const ok = new Set(pipe.ok.items.map(p => p.n));
  const bad = new Set(pipe.bad.items.map(p => p.n));
  const next = new Map();
  for (const p of pipe.prs.values()) {
    const pr = withCoord(p, review);
    pr.stage = stageOf(pr, ok, bad, rebase);
    next.set(p.n, pr);
  }
  const changed = changedPrs(next);
  pipe.prs = next;
  savePipeline();
  queueFromPipeline();
  renderPipeline(changed);
}

function changedPrs(next) {
  return new Set([...next.values()].filter(p => {
    const before = pipe.prs.get(p.n);
    return before && (before.stage !== p.stage || before.checked < p.checked || before.comments < p.comments);
  }).map(p => p.n));
}

/**
 * The live feed's PRs (one search a minute, made anyway): opened ones join, merged ones fly to main, closed ones
 * fade, drafts and comment counts update. The first time after the page opens this happens without animation.
 */
function pipelineFeedItems(items) {
  if (!pipe.fullAt) return;   // the first full load brings everything
  const { rebase, review } = coordSets();
  const ok = new Set(pipe.ok.items.map(p => p.n));
  const bad = new Set(pipe.bad.items.map(p => p.n));
  const animate = pipe.live && pipe.ready;
  const merges = [];
  const changed = new Set();
  let touched = false;
  for (const it of items) {
    if (!it.pr) continue;
    const had = pipe.prs.get(it.n);
    if (it.merged) {
      if (had) merges.push(it);
    } else if (it.state === 'closed') {
      if (had) { animate ? fadeOut(it.n) : dropPr(it.n); touched = true; }
    } else {
      const pr = withCoord({ ...(had || {}), n: it.n, title: it.title, user: it.user, avatar: it.avatar, url: it.url, created: it.created, draft: it.draft, comments: it.comments }, review);
      pr.stage = stageOf(pr, ok, bad, rebase);
      if (had && (had.stage !== pr.stage || had.comments < pr.comments)) changed.add(it.n);
      if (!had || changed.has(it.n) || had.title !== pr.title) touched = true;
      pipe.prs.set(it.n, pr);
    }
  }
  if (animate && merges.length >= ROUND_MIN_SHOW) { pipe.round = { total: merges.length, landed: 0 }; showRound(); }
  merges.sort((a, b) => Date.parse(a.merged) - Date.parse(b.merged))
    .forEach((it, i) => (animate ? setTimeout(() => flyToMain(it.n), i * MERGE_STAGGER_MS) : dropPr(it.n)));
  pipe.live = true;
  if (touched || merges.length) {
    savePipeline();
    queueFromPipeline();
    renderPipeline(animate ? changed : new Set());
  }
}

function dropPr(n) {
  pipe.prs.delete(n);
  const a = pipe.els.get(n);
  pipe.els.delete(n);
  if (a) a.remove();
}

function savePipeline() {
  store.set(PIPE_KEY, { fullAt: pipe.fullAt, ciAt: pipe.ciAt, ok: pipe.ok, bad: pipe.bad, prs: [...pipe.prs.values()] });
}

/** The merge queue section reads the same data: no extra calls. */
function queueFromPipeline() {
  const counts = stageCounts();
  const open = n => pipe.prs.has(n);
  const stageOfN = n => (pipe.prs.get(n) || {}).stage;
  const okOpen = pipe.ok.items.filter(p => open(p.n));
  queue = {
    // CI passing: all of them; `items` only the ones that could be merged (no conflict, not a draft).
    ok: {
      total: okOpen.length,
      items: okOpen.filter(p => stageOfN(p.n) === 'green' || stageOfN(p.n) === 'ready'),
      rebase: okOpen.filter(p => stageOfN(p.n) === 'rebase'),
    },
    bad: { total: pipe.bad.items.filter(p => open(p.n)).length, items: pipe.bad.items.filter(p => open(p.n)) },
    wait: { total: counts.waiting + counts.running },
    draft: { total: counts.draft },
  };
  renderQueue();
  renderTriage();
}

function restorePipeline() {
  const job = store.get(PIPE_JOB_KEY);
  if (job && Date.now() - (job.startedAt || 0) < JOB_KEEP_MS && (!job.full || Array.isArray(job.items))) pipe.job = job;
  const saved = store.get(PIPE_KEY);
  if (!saved || !Array.isArray(saved.prs)) return;
  pipe.prs = new Map(saved.prs.filter(p => p && p.n && p.stage).map(p => [p.n, p]));
  pipe.fullAt = saved.fullAt || 0;
  pipe.ciAt = saved.ciAt || 0;
  pipe.ok = saved.ok && Array.isArray(saved.ok.items) ? saved.ok : pipe.ok;
  pipe.bad = saved.bad && Array.isArray(saved.bad.items) ? saved.bad : pipe.bad;
  if (pipe.prs.size) queueFromPipeline();
}

function stageCounts() {
  const counts = Object.fromEntries(PIPE_STAGES.map(s => [s.key, 0]));
  for (const p of pipe.prs.values()) counts[p.stage]++;
  return counts;
}

/* ================= layout ================= */
/** Narrower than this, the columns can't all keep their minimum width: the stages become rows instead (phones,
 *  narrow windows). */
const COLS_MIN_WIDTH = COL_MIN_W * (PIPE_STAGES.length + 1) + MAIN_W + COL_GAP * (PIPE_STAGES.length + 1) + PAD;
const ROW_HEAD_H = 24;
const ROW_GAP = 6;
const MAIN_H = 40;

/** Where dot i of a column or row goes. */
const dotAt = (col, i) => ({ x: col.dx + (i % col.perRow) * PITCH, y: col.dy + Math.floor(i / col.perRow) * PITCH });

function pipeLayout(width, mergedCount) {
  const counts = stageCounts();
  return width < COLS_MIN_WIDTH ? rowsLayout(width, counts, mergedCount) : colsLayout(width, counts, mergedCount);
}

/** Wide: one column per stage, widths following the number of dots so the tallest column stays short. No column
 *  gets narrower than COL_MIN_W (taking the overflow from the big ones), so none ends up one dot wide. */
function colsLayout(width, counts, mergedCount) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0) + mergedCount || 1;
  const avail = width - MAIN_W - COL_GAP * (PIPE_STAGES.length + 1) - PAD;
  let widths = [...PIPE_STAGES.map(s => counts[s.key]), mergedCount].map(n => Math.max(COL_MIN_W, avail * n / total));
  const over = widths.reduce((a, b) => a + b, 0) - avail;
  if (over > 0) {
    const flexible = widths.map(w => w - COL_MIN_W);
    const room = flexible.reduce((a, b) => a + b, 0) || 1;
    widths = widths.map((w, i) => Math.max(COL_MIN_W, w - over * flexible[i] / room));
  }
  let x = PAD;
  const column = (s, i, n) => {
    const perRow = Math.max(1, Math.floor((widths[i] - 8) / PITCH));
    const col = { ...s, x, y: 0, w: widths[i], perRow, n, rows: Math.ceil(n / perRow), dx: x + 4, dy: HEAD_H };
    x += widths[i] + COL_GAP;
    return col;
  };
  const cols = PIPE_STAGES.map((s, i) => column(s, i, counts[s.key]));
  const main = { x, y: 0, w: MAIN_W - 6 };
  x += MAIN_W;
  const merged = column(MERGED_COL, PIPE_STAGES.length, mergedCount);
  const rows = Math.max(4, ...cols.map(c => c.rows), merged.rows);
  const height = HEAD_H + rows * PITCH + PAD * 2;
  for (const c of [...cols, merged]) c.h = height;
  main.h = height;
  // A merged PR flies to a random height in the main lane.
  const target = () => ({ x: main.x + 24, y: 30 + Math.random() * Math.max(40, height - 60) });
  return { orient: 'cols', width: Math.max(width, x - COL_GAP + PAD), cols, main, merged, height, target };
}

/** Narrow: one row per stage, top to bottom, dots wrapping over the full width; main is a lane across, with the
 *  Merged row under it. */
function rowsLayout(width, counts, mergedCount) {
  const inner = width - PAD * 2;
  const perRow = Math.max(1, Math.floor((inner - 8) / PITCH));
  let y = PAD;
  const row = (s, n) => {
    const rows = Math.ceil(n / perRow);
    const h = ROW_HEAD_H + Math.max(1, rows) * PITCH + 6;
    const col = { ...s, x: PAD, y, w: inner, h, perRow, n, rows, dx: PAD + 4, dy: y + ROW_HEAD_H };
    y += h + ROW_GAP;
    return col;
  };
  const cols = PIPE_STAGES.map(s => row(s, counts[s.key]));
  const main = { x: PAD, y, w: inner, h: MAIN_H };
  y += MAIN_H + ROW_GAP;
  const merged = row(MERGED_COL, mergedCount);
  const height = y - ROW_GAP + PAD;
  const target = () => ({ x: PAD + 20 + Math.random() * Math.max(20, inner - 60), y: main.y + MAIN_H - 14 });
  return { orient: 'rows', width, cols, main, merged, height, target };
}

function positions(layout) {
  const pos = new Map();
  for (const col of layout.cols) {
    const inCol = [...pipe.prs.values()].filter(p => p.stage === col.key).sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
    inCol.forEach((p, i) => pos.set(p.n, dotAt(col, i)));
  }
  return pos;
}

/* ================= rendering ================= */
function dotLabel(p) {
  const stage = PIPE_STAGES[STAGE_INDEX[p.stage]];
  return `#${p.n} ${p.title} by @${p.user}. ${stage.label}. Opened ${ago(p.created)}.`
    + (p.checked ? ` Checked by ${p.checked}.` : '') + (p.comments ? ` ${p.comments} comments.` : '');
}

function makeDot(p) {
  const a = document.createElement('a');
  a.className = 'pdot';
  a.href = p.url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.dataset.n = p.n;
  return a;
}

function styleDot(a, p, pos, opts) {
  const stage = PIPE_STAGES[STAGE_INDEX[p.stage]];
  a.style.setProperty('--c', stage.color);
  a.classList.toggle('checked', p.checked > 0);
  a.classList.toggle('talk', p.comments > 0);
  a.setAttribute('aria-label', dotLabel(p));
  a.classList.toggle('ciok', !!opts.ciok);
  a.classList.toggle('still', !opts.ping);
  if (opts.delay) a.style.transitionDelay = opts.delay + 'ms';
  a.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
  if (opts.ping) {
    a.classList.remove('ping');
    void a.offsetWidth;   // restart the animation
    a.classList.add('ping');
    setTimeout(() => a.classList.remove('ping'), PING_MS);
  }
}

function renderPipeline(changed = new Set()) {
  const box = $('#pipe');
  if (!box) return;
  if (!pipe.prs.size) {
    box.innerHTML = pendingHtml('pipeline');
    return;
  }
  const recentList = recentMerged(RECENT_MERGED_MS);
  const layout = pipeLayout(box.clientWidth, recentList.length);
  const pos = positions(layout);
  const first = !pipe.ready;
  box.classList.toggle('instant', first);
  box.classList.toggle('rows', layout.orient === 'rows');
  box.style.height = layout.height + 'px';
  box.style.minWidth = layout.orient === 'cols' ? layout.width + 'px' : '';

  // Column heads and bands, rebuilt each time (cheap); dots are kept so they can move.
  // The loading placeholder of a first visit goes too, or it stays behind the dots.
  box.querySelectorAll('.pcol, .pmain, .pipe-empty, .pending').forEach(el => el.remove());
  const rect = r => `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
  const work = layout.cols.filter(c => c.work);
  const heads = [...layout.cols, layout.merged].map(c => `<div class="pcol${c.work ? ' work' : ''}${c.key === 'merged' ? ' done' : ''}" style="${rect(c)};--c:${c.color}">
      <b>${fmt(c.n)}</b><span class="nm">${esc(c.label)}</span><span class="hint">${esc(c.hint)}</span></div>`).join('');
  let workBand = '';
  if (work.length) {
    const a = work[0], z = work[work.length - 1];
    workBand = `<div class="pcol band" style="${rect({ x: a.x - 4, y: a.y - 2, w: z.x + z.w - a.x + 8, h: z.y + z.h - a.y + 4 })}"><span>needs work</span></div>`;
  }
  const recent = pipe.mergedRecently.filter(t => Date.now() - t < 3600000).length;
  box.insertAdjacentHTML('afterbegin', workBand + heads + `<div class="pmain" style="${rect(layout.main)}">
      <b>main</b><span class="hint">${recent ? fmt(recent) + ' merged since you opened the page' : 'merged PRs land here'}</span><i></i></div>`);
  pipe.target = layout.target;

  let moved = 0;
  // Passing CI but in another column (needs a rebase, draft): a green corner, so the CI passing count adds up.
  const okSet = new Set(pipe.ok.items.map(x => x.n));
  for (const [n, p] of pipe.prs) {
    let a = pipe.els.get(n);
    const isNew = !a;
    if (isNew) {
      a = makeDot(p);
      pipe.els.set(n, a);
      box.appendChild(a);
      if (!first) a.classList.add('born');
    }
    const ping = changed.has(n);
    const ciok = okSet.has(n) && p.stage !== 'green' && p.stage !== 'ready';
    styleDot(a, p, pos.get(n), { ping, ciok, delay: ping ? (moved++ % 20) * 60 : 0 });
  }
  renderMergedColumn(box, layout.merged, recentList, first);
  if (first) requestAnimationFrame(() => box.classList.remove('instant'));
  pipe.ready = true;
}

/** The Merged column: newest top left, older ones fainter; a PR that just landed in main pops in here. */
function renderMergedColumn(box, col, list, first) {
  const now = Date.now();
  const keep = new Set(list.map(m => m.n));
  for (const [n, a] of pipe.mels) {
    if (keep.has(n)) continue;
    pipe.mels.delete(n);
    a.classList.add('leaving');
    setTimeout(() => a.remove(), FLY_MS);
  }
  list.forEach((m, i) => {
    let a = pipe.mels.get(m.n);
    if (!a) {
      a = document.createElement('a');
      a.className = 'pdot mdot still';
      a.href = `${GH}/pull/${m.n}`;
      a.target = '_blank';
      a.rel = 'noopener';
      a.dataset.m = m.n;
      pipe.mels.set(m.n, a);
      box.appendChild(a);
      if (!first) a.classList.add('born');
    }
    a.style.setProperty('--c', MERGED_COL.color);
    a.style.setProperty('--age', Math.min(1, (now - m.mergedAt) / RECENT_MERGED_MS).toFixed(2));
    a.setAttribute('aria-label', `#${m.n} ${m.title} by @${m.user}. Merged ${ago(m.mergedAt)}.`);
    const at = dotAt(col, i);
    a.style.transform = `translate(${at.x}px, ${at.y}px)`;
  });
}

let landRender = null;
/** Many flights land within a second during a round: redraw once after the last. */
function renderAfterLanding() {
  clearTimeout(landRender);
  landRender = setTimeout(() => renderPipeline(), LAND_RENDER_MS);
}

/* ================= live events ================= */
function flyToMain(n) {
  const a = pipe.els.get(n);
  pipe.prs.delete(n);
  pipe.els.delete(n);
  pipe.mergedRecently.push(Date.now());
  if (!a) return;
  const to = pipe.target ? pipe.target() : { x: 900, y: 100 };
  a.classList.remove('still');
  a.classList.add('merging');
  a.style.transitionDelay = '0ms';
  a.style.transform = `translate(${to.x}px, ${to.y}px) scale(1.6)`;
  setTimeout(() => {
    a.remove();
    const main = $('#pipe .pmain');
    if (main) { main.classList.remove('flash'); void main.offsetWidth; main.classList.add('flash'); }
    renderAfterLanding();   // it pops into the Merged column
  }, FLY_MS);
  if (pipe.round) {
    pipe.round.landed++;
    showRound();
  }
}

function fadeOut(n) {
  const a = pipe.els.get(n);
  pipe.prs.delete(n);
  pipe.els.delete(n);
  if (!a) return;
  a.classList.add('leaving');
  setTimeout(() => a.remove(), FLY_MS);
}

function showRound() {
  const el = $('#pipeRound');
  if (!el || !pipe.round) return;
  el.hidden = false;
  el.innerHTML = `<span>⚡ Merge round</span><b>${pipe.round.landed}/${pipe.round.total}</b><span>into main</span>`;
  if (pipe.round.landed >= pipe.round.total) {
    const done = pipe.round;
    setTimeout(() => { if (pipe.round === done) { pipe.round = null; el.hidden = true; } }, ROUND_HOLD_MS);
  }
}

/* ================= tooltip ================= */
function initPipeline() {
  restorePipeline();
  const box = $('#pipe');
  const tip = $('#pipeTip');
  const show = a => {
    if (a.dataset.m) {
      const m = recentMerged(RECENT_MERGED_MS).find(x => x.n === Number(a.dataset.m));
      if (!m) return;
      tip.innerHTML = `<b>#${esc(m.n)}</b> ${esc(m.title || '(title loads with the next full update)')}
        <div class="m">@${esc(m.user)} · opened ${esc(ago(m.createdAt))}</div>
        <div class="m"><span style="color:${MERGED_COL.color}">● Merged ${esc(ago(m.mergedAt))}</span></div>`;
    } else {
      const p = pipe.prs.get(Number(a.dataset.n));
      if (!p) return;
      const stage = PIPE_STAGES[STAGE_INDEX[p.stage]];
      tip.innerHTML = `<b>#${esc(p.n)}</b> ${esc(p.title)}
        <div class="m">@${esc(p.user)} · opened ${esc(ago(p.created))}</div>
        <div class="m"><span style="color:${stage.color}">● ${esc(stage.label)}</span>${p.checked ? ` · checked by ${p.checked}` : ''}${p.comments ? ` · ${p.comments} comment${p.comments > 1 ? 's' : ''}` : ''}${p.group ? ` · needs ${esc(p.group)}` : ''}</div>`;
    }
    // The tip lives in the card, outside the scrolling box, so it is never cut off; it flips above near the bottom.
    const r = a.getBoundingClientRect();
    const host = tip.parentElement.getBoundingClientRect();
    tip.hidden = false;
    const left = Math.min(r.left - host.left, host.width - tip.offsetWidth - 8);
    const below = r.bottom - host.top + 8;
    const top = below + tip.offsetHeight > host.height ? r.top - host.top - tip.offsetHeight - 8 : below;
    tip.style.transform = `translate(${Math.max(8, left)}px, ${top}px)`;
  };
  box.addEventListener('mouseover', e => { const a = e.target.closest('.pdot'); if (a) show(a); });
  box.addEventListener('focusin', e => { const a = e.target.closest('.pdot'); if (a) show(a); });
  box.addEventListener('mouseleave', () => { tip.hidden = true; });
  box.addEventListener('focusout', () => { tip.hidden = true; });
  new ResizeObserver(() => { if (Math.abs(box.clientWidth - pipe.width) > 4) { pipe.width = box.clientWidth; renderPipeline(); } }).observe(box);
  renderPipeline();
}
