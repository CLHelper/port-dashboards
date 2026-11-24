/* Live feed, merge queue and the sync scheduler of the dashboard.
 * Loaded after the inline script in index.html and uses its helpers: api, rawFile, store, tokenStore, scrub, esc,
 * plain, ago, fmt, toast, showError, searchQ, loadStatus, rate, blockedUntil, the latest* values and the constants.
 *
 * Budget without a token (per network): search 10 a minute, core 60 an hour. One sync a minute while the tab is
 * visible costs 1-2 search calls (the feed), plus one heavier tier at most: status (4 search, 1-2 core) or the merge
 * queue (4 search), each every 5 minutes. Coordination-issue comments (core) are read every minute with a token and
 * every 3 minutes without one; after the issue moves to a new number, the old one is read once more to its end.
 * That stays near 40 core calls an hour. */
'use strict';

const LIVE_BACKFILL_MS = 60 * 60 * 1000;     // the first sync shows the last hour
const LIVE_OVERLAP_MS = 3 * 60 * 1000;       // search results can lag; each sync asks a little further back
const LIVE_KEEP_MS = 6 * 60 * 60 * 1000;     // events older than this leave the feed
const LIVE_MAX_EVENTS = 300;
const LIVE_SHOWN = 80;
const FEED_PAGE = 100;
const COMMENTS_MS_NO_TOKEN = 3 * 60 * 1000;
const COMMENTS_PAGE = 100;                   // comments per request, GitHub's maximum
const COMMENT_ISSUES_MAX = 4;                // coordination issues read per sync: the current one and those just moved
const MANUAL_MIN_MS = 20 * 1000;             // ↻ at most this often
const ROUND_GAP_MS = 90 * 1000;              // merges closer together than this belong to one round
const ROUND_MIN = 5;
const ROUND_FRESH_MS = 15 * 60 * 1000;       // a round this recent gets the banner in the feed
const ROUND_NOW_MS = 3 * 60 * 1000;
const ROUNDS_LISTED = 8;
const AFTERMATH_MS = 2 * 60 * 60 * 1000;
const QUEUE_LISTED = 15;
const FRESH_MS = 5 * 60 * 1000;              // only events this recent move dots in the pipeline; older ones are history
const BOTTLENECK_SHARE = 0.5;
const REBASE_AUTHORS = 10;
const LOW_CORE = 12;                          // warn when fewer core calls than this are left without a token
const TOKEN_RE = /^(gh[pousr]_|github_pat_)[A-Za-z0-9_]+$/;
const TOKEN_URL = 'https://github.com/settings/tokens/new?description=Leonida%20dashboard';
const MERGE_MSG_RE = /^Merge pull request #(\d+) from ([^/\s]+)/;
const REVERT_RE = /^Revert\b/i;
const COMMAND_RE = /^\s*`?(claiming|status|blocked|releasing|done|finding)`?\s*:\s*(.+)$/im;

const EVENT_KIND = {
  merged:  { ic: '🟢', verb: 'merged' },
  opened:  { ic: '📝', verb: 'opened' },
  closed:  { ic: '⛔', verb: 'closed without merging' },
  issue:   { ic: '🗒️', verb: 'new issue' },
  claim:   { ic: '🙋', verb: 'claimed' },
  status:  { ic: '📌', verb: 'status' },
  blocked: { ic: '🧱', verb: 'blocked' },
  release: { ic: '👋', verb: 'released' },
  done:    { ic: '✅', verb: 'done' },
  finding: { ic: '🔎', verb: 'found' },
  comment: { ic: '💬', verb: 'on the coordination issue' },
  revert:  { ic: '↩️', verb: 'revert on main' },
};
const COMMAND_KIND = { claiming: 'claim', status: 'status', blocked: 'blocked', releasing: 'release', done: 'done', finding: 'finding' };

const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const hhmm = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function span(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 120 ? s + ' s' : Math.round(s / 60) + ' min';
}
function fmtDur(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return min + ' min';
  const h = Math.floor(min / 60);
  return h + ' h' + (min % 60 ? ' ' + (min % 60) + ' min' : '');
}
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/* Bars grow from their previous width instead of from zero when a section re-renders. */
const barWidths = new Map();
function growBars(root) {
  const bars = [...root.querySelectorAll('[data-w]')];
  bars.forEach(el => { el.style.width = barWidths.get(el.dataset.k) || '0%'; });
  requestAnimationFrame(() => requestAnimationFrame(() => bars.forEach(el => {
    el.style.width = el.dataset.w;
    barWidths.set(el.dataset.k, el.dataset.w);
  })));
}
const pctW = (n, of) => (of ? Math.max(0, Math.min(100, n / of * 100)).toFixed(1) : 0) + '%';

function untilText(ms) {
  const min = Math.ceil((ms - Date.now()) / 60000);
  return min <= 1 ? 'in about a minute' : `in ${min} min`;
}

/* ================= live feed state ================= */
const live = {
  events: [],           // { key, kind, ts, n, title, user, avatar, url }
  keys: new Set(),
  cursor: 0,            // start of the last feed request that GitHub answered (ms)
  commentsCursors: {},  // coordination issue number → start of its last comment request GitHub answered (ms)
  commentsAt: 0,
  coveredFrom: 0,       // the feed is complete from here on
  partial: false,       // a sync had more updates than two pages hold
  rendered: null,       // keys already on screen; new ones animate in
  error: null,
  feedAt: 0,            // when the feed search last ran
};

function restoreLive() {
  const saved = store.get('live');
  if (!saved || !Array.isArray(saved.events)) return;
  const now = Date.now();
  live.events = saved.events.filter(e => e && e.key && now - e.ts < LIVE_KEEP_MS);
  live.keys = new Set(live.events.map(e => e.key));
  // A saved cursor older than the backfill window is worth nothing: start from the last hour again.
  live.cursor = now - (saved.cursor || 0) < LIVE_BACKFILL_MS ? saved.cursor : 0;
  live.commentsCursors = Object.fromEntries(Object.entries(saved.commentsCursors || {}).filter(([, at]) => now - at < LIVE_BACKFILL_MS));
  live.coveredFrom = live.cursor ? (saved.coveredFrom || 0) : 0;
  live.feedAt = live.cursor ? (saved.feedAt || 0) : 0;
  live.commentsAt = saved.commentsAt || 0;
}

function saveLive() {
  store.set('live', {
    events: live.events, cursor: live.cursor, commentsCursors: live.commentsCursors, coveredFrom: live.coveredFrom,
    feedAt: live.feedAt, commentsAt: live.commentsAt,
  });
}

function addEvent(ev) {
  if (!ev.key || !ev.ts || Number.isNaN(ev.ts) || live.keys.has(ev.key)) return;
  live.keys.add(ev.key);
  live.events.push(ev);
}

function pruneEvents() {
  const now = Date.now();
  live.events = live.events.filter(e => now - e.ts < LIVE_KEEP_MS).sort((a, b) => b.ts - a.ts).slice(0, LIVE_MAX_EVENTS);
  live.keys = new Set(live.events.map(e => e.key));
}

/* ================= live feed: GitHub ================= */
const pickFeedItem = i => ({
  n: i.number, pr: !!i.pull_request, title: i.title, user: i.user ? i.user.login : '', avatar: i.user ? i.user.avatar_url : '',
  url: i.html_url, created: i.created_at, closed: i.closed_at, merged: i.pull_request ? i.pull_request.merged_at : null,
  state: i.state, draft: !!i.draft, comments: i.comments || 0,
});

/** Events in one search result: opened, merged, or closed without merging, each once. */
function feedEvents(item, since) {
  const base = { n: item.n, title: item.title, user: item.user, avatar: item.avatar, url: item.url };
  const at = s => (s ? Date.parse(s) : 0);
  const out = [];
  if (at(item.created) >= since) out.push({ ...base, key: 'open:' + item.n, kind: item.pr ? 'opened' : 'issue', ts: at(item.created) });
  if (item.merged && at(item.merged) >= since) out.push({ ...base, key: 'merged:' + item.n, kind: 'merged', ts: at(item.merged) });
  else if (item.closed && !item.merged && at(item.closed) >= since) out.push({ ...base, key: 'closed:' + item.n, kind: 'closed', ts: at(item.closed) });
  return out;
}

/** Everything updated since the last sync (with some overlap), newest first: one search call, two when busy. */
async function syncFeed() {
  const started = Date.now();
  const from = Math.max(live.cursor ? live.cursor - LIVE_OVERLAP_MS : 0, started - LIVE_BACKFILL_MS);
  const path = page => searchQ(`updated:>=${iso(from)}`) + `&sort=updated&order=desc&per_page=${FEED_PAGE}&page=${page}`;
  const pick = d => ({ total: d.total_count, items: (d.items || []).map(pickFeedItem) });
  const first = await api(path(1), pick, 'live:feed');
  let items = first.data.items;
  let total = first.data.total;
  if (!first.stale && total > FEED_PAGE) {
    const second = await api(path(2), pick, 'live:feed2');
    if (!second.stale) items = items.concat(second.data.items);
  }
  // Only what happened inside the window: an old PR merged now adds its merge, not its opening hours ago.
  items.forEach(it => feedEvents(it, from).forEach(addEvent));
  if (first.stale) return false;   // from the cache: keep the cursor so the next sync asks for the same window
  live.partial = total > items.length;
  if (!live.cursor || live.partial) live.coveredFrom = live.partial ? started : from;
  live.cursor = started;
  live.feedAt = started;
  // The same search keeps the activity chart and the pipeline current: no calls of their own for this.
  mergedFromFeed(items, from, started, !live.partial);
  pipelineFeedItems(items);
  return true;
}

const pickComment = c => ({ id: c.id, user: c.user ? c.user.login : '', avatar: c.user ? c.user.avatar_url : '', at: c.created_at, url: c.html_url, body: String(c.body || '').slice(0, 600) });

function commentEvent(c, n) {
  const m = c.body.match(COMMAND_RE);
  const kind = m ? COMMAND_KIND[m[1].toLowerCase()] : 'comment';
  const text = m ? m[2] : (c.body.split('\n').find(l => l.trim()) || '');
  return { key: 'c:' + c.id, kind, ts: Date.parse(c.at), n, title: plain(text).slice(0, 180), user: c.user, avatar: c.avatar, url: c.url };
}

/**
 * The coordination issues whose comments the feed still needs: the current one, and earlier ones that closed inside
 * the feed window and were not read to their end yet (the issue moves every 15 to 30 minutes).
 */
function commentIssues(now) {
  const windowStart = now - LIVE_BACKFILL_MS;
  const cursors = live.commentsCursors;
  const recent = latestCoordRecent.some(i => i.number === latestCoordNo) ? latestCoordRecent : [{ number: latestCoordNo, created: 0, closed: 0 }];
  return recent.filter(i => i.number === latestCoordNo
    || (i.closed >= windowStart && !(cursors[i.number] - LIVE_OVERLAP_MS > i.closed))).slice(0, COMMENT_ISSUES_MAX);
}

/** Claims and other commands on the coordination issue. Core API, so every 3 minutes without a token. */
async function syncComments() {
  if (!latestCoordNo) return;
  const now = Date.now();
  const every = activeToken() ? SYNC_MS - FEED_SLACK_MS : (attention() === 'active' ? COMMENTS_MS_NO_TOKEN : IDLE_COMMENTS_MS);
  if (now - live.commentsAt < every || !coreSpare()) return;
  live.commentsAt = now;
  const issues = commentIssues(now);
  const cursors = {};
  for (const i of issues) {
    const seen = live.commentsCursors[i.number];
    // An issue seen for the first time is read from its creation: the page may learn of a move minutes after it.
    const from = Math.max(seen ? seen - LIVE_OVERLAP_MS : i.created, now - LIVE_BACKFILL_MS);
    const r = await api(`/repos/${REPO}/issues/${i.number}/comments?since=${iso(from)}&per_page=${COMMENTS_PAGE}`, d => d.map(pickComment), 'live:comments');
    r.data.forEach(c => addEvent(commentEvent(c, i.number)));
    // A full page leaves comments unread (oldest come first): the next sync carries on from the last one read.
    const last = r.data.length >= COMMENTS_PAGE ? Date.parse(r.data[r.data.length - 1].at) : 0;
    cursors[i.number] = r.stale ? seen : last ? last + LIVE_OVERLAP_MS : now;
  }
  // Issues read to their end drop out; their cursor stays so the next sync knows it.
  for (const [n, at] of Object.entries(live.commentsCursors)) if (!(n in cursors) && now - at < LIVE_BACKFILL_MS) cursors[n] = at;
  live.commentsCursors = Object.fromEntries(Object.entries(cursors).filter(([, at]) => at));
}

/** Reverts on main, from the commits the status tier already loaded. */
function addCommitEvents() {
  for (const c of latestCommits) {
    if (REVERT_RE.test(c.msg)) addEvent({ key: 'rv:' + c.url, kind: 'revert', ts: Date.parse(c.date), title: c.msg, user: '', avatar: c.avatar, url: c.url });
  }
}

/* ================= merge rounds ================= */
/** Every merge the page knows: the live feed's, plus the merge commits among main's latest 100 commits. */
function allMerges() {
  const byNo = new Map();
  for (const c of latestCommits) {
    const m = c.msg.match(MERGE_MSG_RE);
    if (m) byNo.set(Number(m[1]), { n: Number(m[1]), ts: Date.parse(c.date), user: m[2], avatar: '', title: '', url: `${GH}/pull/${m[1]}` });
  }
  for (const e of live.events) {
    if (e.kind === 'merged') byNo.set(e.n, { ...byNo.get(e.n), n: e.n, ts: e.ts, user: e.user, avatar: e.avatar, title: e.title, url: e.url });
  }
  return [...byNo.values()].filter(m => m.ts).sort((a, b) => a.ts - b.ts);
}

/** A merge round: ROUND_MIN or more merges with less than ROUND_GAP_MS between neighbours. */
function findRounds(merges) {
  const rounds = [];
  let cur = [];
  const flush = () => {
    if (cur.length >= ROUND_MIN) rounds.push({ start: cur[0].ts, end: cur[cur.length - 1].ts, prs: cur });
    cur = [];
  };
  for (const m of merges) {
    if (cur.length && m.ts - cur[cur.length - 1].ts > ROUND_GAP_MS) flush();
    cur.push(m);
  }
  flush();
  return rounds;
}

/** What landed on main after a round, until the next round: reverts and other direct commits. Null when unknown. */
function aftermath(round, nextStart) {
  const dated = latestCommits.map(c => ({ ...c, ts: Date.parse(c.date) }));
  if (!dated.length || Math.min(...dated.map(c => c.ts)) > round.end) return null;
  const until = Math.min(nextStart || Infinity, round.end + AFTERMATH_MS);
  const after = dated.filter(c => c.ts > round.end && c.ts < until && !MERGE_MSG_RE.test(c.msg));
  return { reverts: after.filter(c => REVERT_RE.test(c.msg)).length, direct: after.length };
}

function aftermathText(a) {
  if (!a) return '';
  if (!a.direct) return 'nothing on main since';
  return [a.reverts ? `↩ ${a.reverts} revert${a.reverts > 1 ? 's' : ''}` : '', `${a.direct} direct commit${a.direct > 1 ? 's' : ''} on main since`].filter(Boolean).join(' · ');
}

/* ================= live feed: render ================= */
function eventRow(e, isNew) {
  const k = EVENT_KIND[e.kind] || EVENT_KIND.comment;
  const onIssue = ['claim', 'status', 'blocked', 'release', 'done', 'finding', 'comment'].includes(e.kind);
  const head = onIssue ? `@${e.user} ${k.verb}` : e.kind === 'revert' ? 'Revert on main' : `#${e.n} ${k.verb}`;
  const who = !onIssue && e.user ? ` <span class="u">@${esc(e.user)}</span>` : '';
  const title = e.kind === 'revert' ? e.title.replace(REVERT_RE, '').trim() : e.title;
  const face = e.avatar ? `<img src="${esc(e.avatar)}&s=56" alt="" loading="lazy">` : '<span class="noav"></span>';
  return `<a class="ev ${esc(e.kind)}${isNew ? ' new' : ''}" href="${esc(e.url)}" target="_blank" rel="noopener" title="${esc(title)}">
    <span class="ic" aria-hidden="true">${k.ic}</span>${face}
    <span class="t"><b>${esc(head)}</b> ${esc(title)}${who}</span><span class="when">${esc(ago(e.ts))}</span></a>`;
}

function roundBanner(round, next, now) {
  const faces = [...new Map(round.prs.filter(p => p.avatar).map(p => [p.user, p.avatar])).values()].slice(0, 24);
  const after = aftermathText(aftermath(round, next));
  const ended = now - round.end < 60000 ? 'just now' : ago(round.end);
  return `<div class="round${now - round.end < ROUND_NOW_MS ? ' now' : ''}">
    <b>⚡ Merge round: ${round.prs.length} PRs in ${span(round.end - round.start)}</b>
    <div class="meta">${hhmm(round.start)} · ended ${esc(ended)}${after ? ' · ' + esc(after) : ''}</div>
    ${faces.length ? `<div class="faces">${faces.map(a => `<img src="${esc(a)}&s=48" alt="" loading="lazy">`).join('')}</div>` : ''}
  </div>`;
}

function renderLive() {
  pruneEvents();
  const now = Date.now();
  if (!live.events.length && live.error) { showError('#liveBody', 'Could not load the live feed', live.error); return; }
  const rounds = findRounds(allMerges());
  const latest = rounds[rounds.length - 1];
  const hour = live.events.filter(e => now - e.ts < 3600000);
  const merged1h = allMerges().filter(m => now - m.ts < 3600000).length;
  const count = (...kinds) => hour.filter(e => kinds.includes(e.kind)).length;
  const people = new Set(hour.map(e => e.user).filter(Boolean)).size;

  const firstPaint = !live.rendered;
  const shown = live.events.slice(0, LIVE_SHOWN);
  const rows = shown.map(e => eventRow(e, !firstPaint && !live.rendered.has(e.key))).join('');
  const fresh = firstPaint ? [] : live.events.filter(e => !live.rendered.has(e.key) && now - e.ts < FRESH_MS);
  live.rendered = new Set(live.events.map(e => e.key));
  const opened = count('opened');
  const closed = count('closed');

  const roundList = rounds.slice(-ROUNDS_LISTED).reverse().map((r, i, arr) => {
    const next = i > 0 ? arr[i - 1].start : null;
    const after = aftermath(r, next);
    return `<div><span>${r.prs.length} PRs in ${span(r.end - r.start)}${after && after.reverts ? ` · ↩ ${after.reverts}` : ''}</span><span class="when">${hhmm(r.start)}</span></div>`;
  }).join('');
  const covered = live.coveredFrom && now - live.coveredFrom < LIVE_BACKFILL_MS ? ` The feed is complete from ${hhmm(live.coveredFrom)} on.` : '';
  const partial = live.partial ? ' Very busy right now: a minute can hold more updates than the page fetches, so a few may be missing.' : '';

  $('#liveBody').innerHTML = `<div class="live-grid">
    <div class="card">
      ${latest && now - latest.end < ROUND_FRESH_MS ? roundBanner(latest, null, now) : ''}
      <div class="evs" aria-live="polite">${rows || '<span style="color:var(--muted)">Nothing happened in the last few hours.</span>'}</div>
      <p class="footnote">Newest first. PRs come from GitHub search, which can trail a minute behind; claims from the coordination issue's comments${activeToken() ? '' : ', every 3 minutes without a token'}.${esc(covered)}${esc(partial)}</p>
    </div>
    <div>
      <div class="subhead" style="margin-top:0">Flow · last 60 minutes</div>
      <div class="card">${flowHtml(opened, merged1h, closed)}<p class="footnote">${esc(roundRhythm(rounds, now))}</p></div>
      <div class="subhead">Last 60 minutes</div>
      <div class="stats">
        <div class="stat"><b>${fmt(merged1h)}</b><span>PRs merged</span></div>
        <div class="stat"><b>${fmt(count('opened'))}</b><span>PRs opened</span></div>
        <div class="stat"><b>${fmt(count('claim'))}</b><span>items claimed</span></div>
        <div class="stat"><b>${fmt(people)}</b><span>people active</span></div>
      </div>
      <div class="subhead">Merge rounds</div>
      <div class="card"><div class="rounds" style="margin-top:0">${roundList || '<span style="color:var(--muted)">None in the commits loaded so far.</span>'}</div>
        <p class="footnote">A round is ${ROUND_MIN} or more merges less than ${ROUND_GAP_MS / 1000} s apart. Older rounds come from the latest 100 commits on ${esc(BRANCH)}; ↩ counts reverts after a round.</p></div>
    </div>
  </div>`;
  growBars($('#liveBody'));
}

/** In versus out: is the queue growing or shrinking this hour? */
function flowHtml(opened, merged, closed) {
  const out = merged + closed;
  const max = Math.max(1, opened, out);
  const net = opened - out;
  const verdict = net > 0 ? `<b class="up">+${fmt(net)}</b> open PRs this hour: more come in than go out`
    : net < 0 ? `<b class="down">${fmt(net)}</b> open PRs this hour: the queue is shrinking`
      : 'In and out are even this hour';
  return `<div class="flow">
      <span>In</span><div class="bar"><i data-k="f-in" data-w="${pctW(opened, max)}" style="background:var(--sun)"></i></div><span class="v">${fmt(opened)}</span>
      <span>Out</span><div class="bar"><i data-k="f-merged" data-w="${pctW(merged, max)}" style="background:var(--done)"></i><i data-k="f-closed" data-w="${pctW(closed, max)}" style="background:var(--dim)"></i></div><span class="v">${fmt(out)}</span>
    </div>
    <div class="net">${verdict}</div>`;
}

/** When the last round was and how often they come, from the rounds the page knows. */
function roundRhythm(rounds, now) {
  const legend = 'Out: merged (green) and closed without merging (grey).';
  const latest = rounds[rounds.length - 1];
  if (!latest) return `${legend} No merge round in the commits loaded so far.`;
  const gaps = rounds.slice(1).map((r, i) => r.start - rounds[i].start);
  const every = gaps.length ? ` Rounds come about every ${fmtDur(median(gaps))}.` : '';
  return `${legend} Last merge round ${fmtDur(now - latest.end)} ago, ${latest.prs.length} PRs.${every}`;
}

/* ================= merge queue ================= */
// Filled by pipeline.js from the same load as the pipeline chart: { ok, bad, wait, draft }, each { total, items }.
let queue = null;

function prList(list, emptyText) {
  if (!list || !list.items.length) return `<span style="color:var(--muted)">${emptyText}</span>`;
  return `<div class="prs">${list.items.slice(0, QUEUE_LISTED).map(p => `<a href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(p.title)}">
    <span class="n">#${esc(p.n)}</span><span class="t">${esc(p.title)} <span style="color:var(--muted)">@${esc(p.user)}</span></span><span class="when">${esc(ago(p.created))}</span></a>`).join('')}</div>`;
}

const searchLink = q => `${GH}/pulls?q=${encodeURIComponent(q)}`;
const moreLink = (list, q) => list && list.total > QUEUE_LISTED
  ? `<p class="footnote"><a href="${esc(searchLink(q))}" target="_blank" rel="noopener">All ${fmt(list.total)} on GitHub ↗</a></p>` : '';

function renderQueue() {
  const total = l => (l ? l.total : null);
  if (!queue) return;
  const coord = latestCoord;
  const tiles = [
    ['', latestOpenPrs, 'open PRs'],
    ['ok', total(queue.ok), queue.ok && queue.ok.rebase && queue.ok.rebase.length ? `CI passing · ${queue.ok.rebase.length} need a rebase` : 'CI passing'],
    ['bad', total(queue.bad), 'CI failing'],
    ['wait', total(queue.wait), 'CI waiting'],
    ['', total(queue.draft), 'drafts'],
    ['bad', coord ? coord.rebase : null, 'need a rebase'],
  ].map(([cls, n, label]) => `<div class="stat ${cls}"><b>${fmt(n)}</b><span>${label}</span></div>`).join('');
  const rebase = coord && coord.rebaseBy.length
    ? `<div class="authors">${coord.rebaseBy.slice(0, REBASE_AUTHORS).map(a => `<div><span class="who">@${esc(a.user)}</span> ${a.prs.map(n => `<a href="${GH}/pull/${esc(n)}" target="_blank" rel="noopener">#${esc(n)}</a>`).join(', ')}</div>`).join('')}</div>
       ${coord.rebaseBy.length > REBASE_AUTHORS ? `<p class="footnote">And ${coord.rebaseBy.length - REBASE_AUTHORS} more authors in the coordination issue.</p>` : ''}`
    : '<span style="color:var(--muted)">None listed.</span>';
  const chains = coord && coord.chains.length
    ? coord.chains.slice(0, chainsShown).map(c => `<div class="chain">${c.map(n => `<a href="${GH}/pull/${esc(n.slice(1))}" target="_blank" rel="noopener">${esc(n)}</a>`).join(' → ')}</div>`).join('')
      + (coord.chains.length > chainsShown ? `<button class="linkbtn list-more" type="button" data-chains>${moreLabel(coord.chains.length - chainsShown)}</button>` : '')
    : '<span style="color:var(--muted)">No chains listed.</span>';
  const html = `<div class="tiles">${tiles}</div>
    ${bottleneckHtml(coord)}
    <div class="queue-grid">
      <div class="card"><div class="subhead" style="margin-top:0">Ready: CI green, no conflicts, oldest first</div>
        ${prList(queue.ok, 'No open PR is green without conflicts right now.')}
        ${queue.ok && queue.ok.rebase && queue.ok.rebase.length ? `<p class="footnote">Also green, but they conflict with ${esc(BRANCH)}, so they sit in Needs rebase: ${queue.ok.rebase.map(p => `<a href="${esc(p.url)}" target="_blank" rel="noopener">#${esc(p.n)}</a>`).join(', ')}.</p>` : ''}
        ${moreLink(queue.ok, 'is:pr is:open draft:false status:success sort:created-asc')}</div>
      <div class="card"><div class="subhead" style="margin-top:0">CI failing, oldest first</div>
        ${prList(queue.bad, 'No open PR has failing CI.')}${moreLink(queue.bad, 'is:pr is:open status:failure sort:created-asc')}</div>
      <div class="card"><div class="subhead" style="margin-top:0">Needs a rebase on ${esc(BRANCH)}</div>${rebase}
        <p class="footnote">From the coordination issue: PRs that conflict after the last merge round, by author.</p></div>
      <div class="card"><div class="subhead" style="margin-top:0">Merge in this order</div>${chains}
        <p class="footnote">Chains of PRs that build on each other, from the coordination issue.</p></div>
    </div>
    <p class="footnote">CI waiting mostly means a fork's first run waits for a maintainer to approve it. The counts come from the same load as the pipeline above, ${graphCovers() ? `your token's sweep every ${Math.round(GRAPH_MS / 60000)} minutes` : `every ${Math.round(pipeInterval() / 60000)} minute${pipeInterval() > 60000 ? 's' : ''}`}.</p>`;
  const box = $('#queueBody');
  if (!box.dataset.more) {
    box.dataset.more = '1';
    box.addEventListener('click', e => {
      if (!e.target.closest('[data-chains]')) return;
      chainsShown += MORE_STEP;
      renderQueue();
    });
  }
  if (html === queueHtml) return;   // runs after every feed update: leave an unchanged section alone
  queueHtml = html;
  box.innerHTML = html;
}
let queueHtml = '';
const CHAINS_FIRST = 5;                  // merge chains shown before "Show more"
let chainsShown = CHAINS_FIRST;

/** The bottleneck the open PRs point at. */
function bottleneckHtml(coord) {
  const n = l => (l ? l.total : 0);
  const segs = [
    ['ok', 'CI passing', 'var(--done)', n(queue.ok)],
    ['bad', 'CI failing', 'var(--todo)', n(queue.bad)],
    ['wait', 'CI waiting', 'var(--wip)', n(queue.wait)],
    ['draft', 'drafts', 'var(--dim)', n(queue.draft)],
  ];
  const sum = segs.reduce((a, seg) => a + seg[3], 0);
  const open = latestOpenPrs || sum;
  const share = v => Math.round(v / (open || 1) * 100);
  const ok = segs[0][3];
  const wait = segs[2][3];
  const oldest = queue.ok && queue.ok.items[0];
  const oldestText = oldest ? ` The oldest green one, <a href="${esc(oldest.url)}" target="_blank" rel="noopener">#${esc(oldest.n)}</a>, was opened ${esc(ago(oldest.created))}.` : '';
  let callout;
  if (wait / (open || 1) >= BOTTLENECK_SHARE) {
    callout = `<b>Bottleneck: CI approval.</b> ${fmt(wait)} of ${fmt(open)} open PRs (${share(wait)}%) have no CI result yet; a fork's first run waits for a maintainer to approve it. Only ${fmt(ok)} are green${queue.ok.rebase && queue.ok.rebase.length ? `, and ${queue.ok.rebase.length} of those need a rebase first` : ''}.${oldestText}`;
  } else if (coord && coord.rebase > ok) {
    callout = `<b>Bottleneck: rebases.</b> ${fmt(coord.rebase)} PRs conflict with ${esc(BRANCH)} after the last round, more than the ${fmt(ok)} that are green.${oldestText}`;
  } else {
    callout = `<b>${fmt(ok)} PRs are green</b> and could go in the next merge round.${oldestText}`;
  }
  return `<p class="callout comp">${callout}</p>`;
}

/* ================= banner: rate limits and the token ================= */
let bannerKey = null;
let bannerClosed = '';
let bannerOffer = false;   // the viewer asked for the token steps from the status bar

function bannerState() {
  const now = Date.now();
  const token = tokenStore.get();
  if (token && tokenRefused) return { key: 'badtoken' };
  const coreUntil = blockedUntil.core || 0;
  if (coreUntil > now) return { key: token ? 'limit-token' : 'limit', until: coreUntil };
  const r = rate.core;
  if (!token && r && r.reset > now && r.remaining <= LOW_CORE) return { key: 'low', until: r.reset, left: r.remaining };
  if (!token && bannerOffer) return { key: 'offer' };
  return { key: '' };
}

function tokenSteps(saveLabel) {
  return `<ol>
    <li><a href="${TOKEN_URL}" target="_blank" rel="noopener">Open GitHub's “New personal access token” page ↗</a> and sign in if it asks.</li>
    <li>Leave <b>every scope box unticked</b>: the page only reads public data. Pick an expiry, then click <b>Generate token</b> at the bottom.</li>
    <li>Copy the token (it starts with <code>ghp_</code>) and paste it here:
      <div class="token-row"><input id="bannerToken" type="password" placeholder="ghp_…" autocomplete="off" aria-label="GitHub token">
      <button class="btn primary" id="bannerSave" type="button">${saveLabel}</button></div></li>
  </ol>
  <p class="fine">The token stays in this browser's local storage and is sent only to api.github.com. You can remove it at the bottom of the page.</p>`;
}

function bannerHtml(st) {
  const cd = st.until ? `<span data-until="${st.until}">${untilText(st.until)}</span>` : '';
  const shown = staleSince ? ` It shows the data it saved at <b>${hhmm(staleSince)}</b> until then.` : '';
  if (st.key === 'limit') {
    return `<h3>GitHub's hourly limit for your network is used up</h3>
      <p>Without a token GitHub allows 60 requests an hour per network, shared by everyone on it (a VPN or an office counts as one network). The page goes live again at <b>${hhmm(st.until)}</b> (${cd}).${shown} To keep it live now, add a free token:</p>
      ${tokenSteps('Save and update')}`;
  }
  if (st.key === 'low') {
    return `<h3>Your network is almost out of GitHub requests</h3>
      <p>Only <b>${st.left}</b> of GitHub's 60 requests an hour are left for your network, shared by everyone on it (a VPN or an office counts as one network). At 0 the page pauses until <b>${hhmm(st.until)}</b> (${cd}). A free token raises the limit to 5,000 an hour:</p>
      ${tokenSteps('Save')}`;
  }
  if (st.key === 'offer') {
    return `<h3>Load the page faster with a free GitHub token</h3>
      <p>Without a token GitHub allows 10 searches a minute and 60 requests an hour, shared by everyone on your network, so the first visit fills in over a few minutes. A token raises that to 30 searches a minute and 5,000 requests an hour:</p>
      ${tokenSteps('Save and load')}`;
  }
  if (st.key === 'limit-token') {
    return `<h3>GitHub's limit for your token is used up</h3>
      <p>The page goes live again at <b>${hhmm(st.until)}</b> (${cd}).${shown}</p>`;
  }
  return `<h3>GitHub no longer accepts your saved token</h3>
    <p>It may have expired or been deleted. The page carries on without it, at 60 requests an hour for your network. Make a new one, or remove the old one:</p>
    ${tokenSteps('Save new token')}
    <p><button class="btn" id="bannerRemove" type="button">Remove the old token</button></p>`;
}

function renderBanner() {
  const st = bannerState();
  const key = st.key + ':' + (st.until || '');
  const box = $('#banner');
  for (const el of box.querySelectorAll('[data-until]')) el.textContent = untilText(Number(el.dataset.until));
  if (key === bannerKey) return;   // keep what the viewer is typing
  bannerKey = key;
  if (!st.key || st.key === bannerClosed) { box.hidden = true; box.innerHTML = ''; return; }
  box.className = 'banner' + (st.key === 'badtoken' ? ' bad' : '');
  box.innerHTML = `<div class="wrap"><div>${bannerHtml(st)}</div><button class="btn" id="bannerClose" type="button" aria-label="Close this message">Close</button></div>`;
  box.hidden = false;
  const input = $('#bannerToken');
  if (input) {
    $('#bannerSave').addEventListener('click', () => saveToken(input.value));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') saveToken(input.value); });
  }
  const remove = $('#bannerRemove');
  if (remove) remove.addEventListener('click', removeToken);
  $('#bannerClose').addEventListener('click', () => { bannerClosed = st.key; bannerOffer = false; box.hidden = true; });
}

function saveToken(raw) {
  const v = String(raw || '').trim();
  if (!TOKEN_RE.test(v)) { toast('That does not look like a GitHub token: it starts with ghp_ or github_pat_'); return; }
  tokenStore.set(v);
  tokenRefused = false;
  delete blockedUntil.core;
  delete blockedUntil.search;
  bannerClosed = '';
  bannerOffer = false;
  $('#tokenInput').value = '••••••••';
  toast('Token saved in this browser');
  sync.statusAt = 0;   // reload everything with the new allowance
  runSync(true);
}

function removeToken() {
  tokenStore.set('');
  tokenRefused = false;
  $('#tokenInput').value = '';
  toast('Token removed');
  renderBanner();
  renderRate();
}

/* ================= what is loaded, and what waits for GitHub ================= */
// Each part of the page reports its state, so the status bar and the placeholders can say what happens:
// loading, waiting for a rate limit (until when, and why), done, or an error.
const parts = {
  status: { label: 'Project status', state: 'loading' },
  feed: { label: 'Live feed', state: 'loading' },
  pipeline: { label: 'PR pipeline', state: 'loading' },
  activity: { label: 'Activity, last 24 hours', state: 'loading' },
};
const FEED_SLACK_MS = 5 * 1000;   // a catch-up sync shortly after a regular one doesn't search the feed again

function setPart(key, patch) {
  parts[key] = { label: parts[key].label, ...patch };
}

const mmss = ms => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const limitText = res => (res === 'core'
  ? (activeToken() ? '5,000 requests an hour with your token' : '60 requests an hour, shared by everyone on your network')
  : (activeToken() ? '30 searches a minute with your token' : '10 searches a minute without a token'));

/** What is blocking a part that could not load: the resource and until when. */
function waitingOn() {
  const now = Date.now();
  if ((blockedUntil.core || 0) > now) return { res: 'core', until: blockedUntil.core };
  return { res: 'search', until: searchResetAt() };
}

function partProgress(key) {
  if (key === 'pipeline') {
    const need = pipelineNeeds();
    return need && need.full ? `${need.done} of ${need.total} calls done` : '';
  }
  if (key === 'activity') {
    const p = mergedProgress();
    return p.complete ? '' : `${p.hours} of ${p.of} hours loaded`;
  }
  return '';
}

const untilLabel = until => (until - Date.now() > 0 ? `continues in ${mmss(until - Date.now())}` : 'continuing now…');

/** The headline of a placeholder box: what it does or waits for, with the countdown. */
function partTitle(key) {
  const p = parts[key];
  if (p.state === 'waiting') return `⏳ Waiting for GitHub's ${p.res === 'core' ? 'hourly' : 'search'} limit · ${untilLabel(p.until)}`;
  if (p.state === 'error') return '⚠ Could not load this yet';
  return 'Loading from GitHub…';
}

function partMessage(key) {
  const p = parts[key];
  const progress = partProgress(key);
  if (p.state === 'waiting') {
    const why = p.res === 'core' ? `GitHub's hourly limit (${limitText('core')})` : `GitHub's search limit (${limitText('search')})`;
    return `Waiting for ${why}: this part ${untilLabel(p.until)}${progress ? ` (${progress})` : ''}. The page is working and continues by itself.`;
  }
  if (p.state === 'error') return `Could not load this yet: ${p.msg}. The page tries again at the next update, in ${mmss(sync.last + SYNC_MS - Date.now())}.`;
  if (p.state === 'done' || p.state === 'cached') return '';
  return `Loading from GitHub…${progress ? ` ${progress}.` : ''}`;
}

/** A placeholder that says what a part waits for; renderParts keeps its text current. */
function pendingHtml(key) {
  return `<div class="pending" data-part="${esc(key)}"><div class="skeleton"></div>
    <div class="pending-box"><b class="pending-title">${esc(partTitle(key))}</b><p class="pending-msg">${esc(partMessage(key))}</p>
    <button class="linkbtn pb-token" type="button" hidden>Load faster with a free token</button></div></div>`;
}

/** Where nothing is shown yet, a wait is a warning box; the explanation says what it waits for and why. */
function boxMessage(key) {
  const p = parts[key];
  const progress = partProgress(key);
  if (p.state === 'waiting') {
    const limit = limitText(p.res === 'core' ? 'core' : 'search');
    return `Nothing is wrong: GitHub allows ${limit}, and this part needs more than that.${progress ? ` So far: ${progress}.` : ''} The page continues by itself when the limit resets.`;
  }
  return partMessage(key);
}

function rateLine(res, label, per) {
  const r = rate[res];
  if (!r) return `<span>${label}: not used yet</span>`;
  // Past GitHub's reset time the last count is out of date: the allowance is full again until the next call says more.
  if (r.reset <= Date.now()) return `<span>${label}: all ${r.limit} available again since ${hhmm(r.reset)} (exact count on the next call)</span>`;
  const used = r.limit - r.remaining;
  const reset = per === 'minute' ? `resets in ${mmss(r.reset - Date.now())}` : `resets at ${hhmm(r.reset)}`;
  const low = r.remaining <= (per === 'minute' ? 1 : LOW_CORE);
  return `<span class="${low ? 'low' : ''}">${label}: <b>${used}</b> of ${r.limit} used this ${per}, ${reset}</span>`;
}

/** "search 3/30": used of the limit; amber when low; the full line (with the reset time) is the bar's tooltip. */
function rateShort(res, label) {
  const r = rate[res];
  if (!r) return `${label} –`;
  if (r.reset <= Date.now()) return `${label} 0/${fmt(r.limit)}`;
  const low = r.remaining <= (res === 'search' ? 1 : LOW_CORE);
  return `<span class="${low ? 'low' : ''}">${label} <b>${fmt(r.limit - r.remaining)}</b>/${fmt(r.limit)}</span>`;
}

function renderParts() {
  const bar = $('#netbar');
  const keys = Object.keys(parts);
  const pending = keys.filter(k => parts[k].state !== 'done' && parts[k].state !== 'cached');
  const waiting = pending.filter(k => parts[k].state === 'waiting');
  const cached = keys.filter(k => parts[k].state === 'cached');
  const list = pending.map(k => `${parts[k].label}${partProgress(k) ? ` (${partProgress(k)})` : ''}`).join(', ');
  let status;
  if (!pending.length && cached.length) {
    const at = Math.min(...cached.map(k => parts[k].at || Date.now()));
    status = `<span class="busy">↻ Showing what this browser saved at <b>${hhmm(at)}</b>; updating from GitHub…</span>`;
  } else if (!pending.length) status = '<span class="ok">✓ All data loaded.</span>';
  else if (waiting.length) {
    const next = Math.min(...waiting.map(k => parts[k].until));
    const res = waiting.some(k => parts[k].res === 'core') ? 'core' : 'search';
    // The countdown first: the end of a long list is what the bar cuts off.
    status = `<span class="wait">⏳ More in <b>${mmss(next - Date.now())}</b>, by itself · still loading: ${esc(list)} (GitHub allows ${esc(limitText(res))})</span>`;
  } else status = `<span class="busy">↻ Loading: ${esc(list)}…</span>`;
  // Outside the message, so a long message never pushes it out of sight.
  const offer = !activeToken() && pending.length ? '<button class="linkbtn nb-offer" id="offerToken" type="button">Load faster with a free GitHub token</button>' : '';
  // The bar shows a short summary; the full sentence is its tooltip.
  const full = `GitHub requests ${activeToken() ? 'with your token' : 'without a token'} · this page made <b>${fmt(apiCalls)}</b> · ${rateLine('search', 'search', 'minute')} · ${rateLine('core', 'other', 'hour')}${rate.graphql ? ' · ' + rateLine('graphql', 'GraphQL', 'hour') : ''}${coreSpare() ? '' : ' · <span class="low">saving the hourly allowance: claims and commits wait</span>'} · ${attention() === 'active' ? 'updates every minute' : 'idle: updates every 5 minutes'}`;
  const short = `${activeToken() ? 'token' : 'no token'} · <b>${fmt(apiCalls)}</b> calls · ${rateShort('search', 'search')} · ${rateShort('core', 'other')}${rate.graphql ? ' · ' + rateShort('graphql', 'GraphQL') : ''}${coreSpare() ? '' : ' · <span class="low">saving</span>'} · ${attention() === 'active' ? '1' : '5'} min`;
  const html = `<div class="wrap">
      <div class="nb-status"><span class="nb-msg" title="${esc(status.replace(/<[^>]+>/g, ''))}">${status}</span>${offer}</div>
      <div class="nb-rates" title="${esc(full.replace(/<[^>]+>/g, ''))}">${short}</div>
    </div>`;
  // This runs every second: writing the same HTML or text again would still make the browser lay out and repaint.
  if (html !== netbarHtml) {
    netbarHtml = html;
    bar.innerHTML = html;
    const btn = $('#offerToken');
    if (btn) btn.addEventListener('click', () => { bannerOffer = true; bannerClosed = ''; bannerKey = null; renderBanner(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  }
  for (const el of document.querySelectorAll('[data-part]')) {
    const key = el.dataset.part;
    const state = parts[key].state;
    el.classList.toggle('warn', state === 'waiting');
    el.classList.toggle('bad', state === 'error');
    setText(el.querySelector('.pending-title'), partTitle(key));
    setText(el.querySelector('.pending-msg'), boxMessage(key));
    const btn = el.querySelector('.pb-token');
    if (btn) btn.hidden = !(state === 'waiting' && !activeToken());
  }
  for (const el of document.querySelectorAll('[data-part-msg]')) setText(el, partMessage(el.dataset.partMsg));
}
let netbarHtml = '';

/** Set an element's text only when it differs. */
function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

/* ================= attention: active, idle or away ================= */
// Without a token the hourly allowance (60 per network) is what runs out, so a visitor who isn't looking costs less:
// - active (tab in view, mouse, keys or scrolling in the last IDLE_AFTER_MS): everything as usual, every minute;
// - idle (in view, nobody touching it): updates every IDLE_SYNC_MS, claims and the status less often;
// - away (tab hidden): nothing, unless the data is still building up. A first visit keeps filling in the
//   background: those are search calls, whose allowance resets every minute, so finishing costs nothing later.
// Whatever the mode, optional hourly calls (claims, the commit list) stop when fewer than CORE_RESERVE are left.
const IDLE_AFTER_MS = 3 * 60 * 1000;
const IDLE_SYNC_MS = 5 * 60 * 1000;
const IDLE_STATUS_MS = 15 * 60 * 1000;
const IDLE_COMMENTS_MS = 10 * 60 * 1000;
const CORE_RESERVE = 15;
let lastSeen = Date.now();

function attention() {
  if (document.hidden) return 'away';
  return Date.now() - lastSeen >= IDLE_AFTER_MS ? 'idle' : 'active';
}
const syncEvery = () => (attention() === 'active' ? SYNC_MS : IDLE_SYNC_MS);

/** Still filling in: a first load of the status, the pipeline or the 24 hours is not finished. */
function building() {
  return ['status', 'pipeline', 'activity'].some(k => parts[k].state !== 'done' && parts[k].state !== 'cached') || !!pipe.job || !!mergedJob;
}

/** Room for optional hourly calls: always with a token, else while more than CORE_RESERVE are left. */
function coreSpare() {
  if (activeToken()) return true;
  const r = rate.core;
  return !r || r.reset <= Date.now() || r.remaining > CORE_RESERVE;
}

function noteActivity() {
  const wasIdle = attention() === 'idle';
  lastSeen = Date.now();
  // Back from idle: the minute rhythm applies again, so update now if a minute has passed.
  if (wasIdle && !sync.running && Date.now() - sync.last >= SYNC_MS) runSync();
}

/* ================= scheduler ================= */
const sync = { last: 0, running: false, again: false, statusAt: 0, failed: false };

function stateAfterLimit(ok) {
  if (ok) return { state: 'done' };
  return { state: 'waiting', ...waitingOn() };
}

async function runSync(force) {
  if (sync.running) { if (force) sync.again = true; return; }
  sync.running = true;
  anyStale = false;
  staleSince = 0;
  live.error = null;
  renderClock();
  const now = Date.now();
  let failed = false;
  try {
    const mode = attention();
    const statusEvery = mode === 'active' ? STATUS_MS : IDLE_STATUS_MS;
    const statusWanted = !sync.statusAt || (mode !== 'away' && coreSpare());
    if (statusWanted && now - sync.statusAt >= statusEvery) {
      sync.statusAt = now;
      setPart('status', { state: 'loading' });
      const statusFailed = await loadStatus();
      const limited = (blockedUntil.core || 0) > Date.now() || (blockedUntil.search || 0) > Date.now();
      if (statusFailed && limited) { setPart('status', { state: 'waiting', ...waitingOn() }); sync.statusAt = 0; }
      else if (statusFailed) setPart('status', { state: 'error', msg: 'GitHub did not answer' });
      else setPart('status', { state: 'done' });
      store.set('sync', { statusAt: sync.statusAt });
      failed = statusFailed;
      restagePipeline();   // the coordination issue may have new rebases or checks
      renderQueue();
    }
    // The feed once a minute; a catch-up sync right after a limit reset skips it.
    if (mode !== 'away' && Date.now() - live.feedAt >= syncEvery() - FEED_SLACK_MS) {
      const [feed, comments] = await Promise.allSettled([syncFeed(), syncComments()]);
      if (feed.status === 'rejected') {
        failed = true;
        live.error = feed.reason;
        console.error('[dashboard] live feed', feed.reason);
        setPart('feed', feed.reason instanceof RateLimitError ? { state: 'waiting', ...waitingOn() } : { state: 'error', msg: feed.reason.message });
      } else setPart('feed', stateAfterLimit(feed.value));
      if (comments.status === 'rejected') console.error('[dashboard] coordination comments', comments.reason);
      addCommitEvents();
      renderLive();
    }
    // With a token one GraphQL sweep (triage.js) brings every open PR; otherwise, or when it fails, what is left of
    // the search limit goes to the pipeline first, then to the activity chart.
    const graphState = await syncGraph(Date.now());
    const pipeState = graphState === 'done' || graphState === 'idle' ? graphState : await loadPipeline(Date.now());
    if (pipeState === 'waiting') setPart('pipeline', { state: 'waiting', ...waitingOn() });
    else if (pipeState === 'error') setPart('pipeline', { state: 'error', msg: 'the search failed' });
    else if (pipe.fullAt) setPart('pipeline', { state: 'done' });
    const merged = await loadMerged();
    if (merged.waiting) setPart('activity', { state: 'waiting', ...waitingOn() });
    else if (merged.error) setPart('activity', { state: 'error', msg: 'the search failed' });
    else setPart('activity', mergedProgress().complete ? { state: 'done' } : { state: 'loading' });
    if (latestActivity) renderPulse(latestActivity, latestCommits);
  } catch (e) {
    console.error('[dashboard] sync failed', e);
    failed = true;
  }
  // Saved data that this sync didn't need to fetch again is current: it no longer counts as "saved at".
  for (const key of Object.keys(parts)) if (parts[key].state === 'cached') setPart(key, { state: 'done' });
  sync.last = Date.now();
  sync.failed = failed;
  sync.running = false;
  saveLive();
  renderClock();
  renderBanner();
  renderRate();
  renderParts();
  if (sync.again) { sync.again = false; runSync(); }
}

/** A part waits for a limit that has reset by now: go on without waiting for the next minute. */
function catchUpDue(now) {
  const waits = Object.values(parts).filter(p => p.state === 'waiting').map(p => p.until);
  return waits.length > 0 && now >= Math.min(...waits) + 500 && now - sync.last > 2000;
}

function syncNow() {
  if (sync.running) { toast('Already updating…'); return; }
  const wait = sync.last + MANUAL_MIN_MS - Date.now();
  if (wait > 0) { toast(`Up to date: the next update is in ${Math.ceil((sync.last + SYNC_MS - Date.now()) / 1000)} s`); return; }
  runSync();
}

function renderClock() {
  const now = Date.now();
  const nextMs = sync.last + syncEvery() - now;
  const next = nextMs > 90000 ? mmss(nextMs) : `${Math.max(0, Math.ceil(nextMs / 1000))} s`;
  // Short, so the menu keeps its room in the top bar; the longer explanation is the tooltip.
  let cls = '';
  let text;
  let tip = '';
  if (sync.running) { text = 'Updating…'; tip = 'Asking GitHub for what changed'; }
  else if (!sync.last) { text = 'Connecting…'; tip = 'Connecting to GitHub'; }
  else if (document.hidden) text = building() ? 'Loading' : 'Paused';
  else if (attention() === 'idle') { cls = 'stale'; text = `Idle, next: ${next}`; tip = 'Nobody is using the page, so it updates less often. Move the mouse for every minute.'; }
  else if ((blockedUntil.core || 0) > now) { cls = 'stale'; text = `Waiting until ${hhmm(blockedUntil.core)}`; tip = "GitHub's hourly limit is used up; live again at that time."; }
  else if (anyStale) { cls = 'stale'; text = `Cached, next: ${next}`; tip = `Part of the data is from ${hhmm(staleSince)}, saved by this browser.`; }
  else if (sync.failed) { cls = 'err'; text = `Offline, retry: ${next}`; tip = 'Part of the last update failed; it tries again.'; }
  else { text = `Live, next: ${next}`; tip = `Updated ${ago(sync.last)}`; }
  const dot = $('#liveDot');
  const dotClass = 'dot' + (cls ? ' ' + cls : '');
  if (dot.className !== dotClass) dot.className = dotClass;
  const txt = $('#liveTxt');
  setText(txt, text);
  if (txt.title !== tip) txt.title = tip;
}

function renderRate() {
  const list = Object.entries(rate).map(([k, r]) => `${k}: ${r.remaining}/${r.limit} left, resets ${hhmm(r.reset)}`);
  const auth = activeToken() ? 'with your token' : 'without a token';
  $('#rateTxt').textContent = `Tracking ${REPO} (${BRANCH}) · updates every minute while this tab is open · GitHub API ${auth}: ${list.join(' · ') || 'limits unknown'}`;
}

/**
 * F5 or a later visit: draw everything this browser saved at once and mark it as saved, then update only what is
 * due. Status data younger than STATUS_MS, a feed younger than a minute and a pipeline or chart that is complete are
 * not asked for again.
 */
async function startSync() {
  initPipeline();
  restoreLive();
  if (live.events.length) renderLive();
  cacheOnly = true;
  let statusSaved = false;
  // loadStatus reports failure when the README, the coordination issue or the merge count is missing: then the
  // browser has nothing usable saved and the status must be fetched, whatever the saved time says.
  try { statusSaved = !(await loadStatus()); } catch (e) { console.warn('[dashboard] nothing saved from an earlier visit yet', e); } finally { cacheOnly = false; }
  const saved = store.get('sync') || {};
  if (statusSaved && saved.statusAt && Date.now() - saved.statusAt < STATUS_MS) sync.statusAt = saved.statusAt;
  if (statusSaved) setPart('status', { state: 'cached', at: saved.statusAt || Date.now() });
  if (live.events.length && live.feedAt) setPart('feed', { state: 'cached', at: live.feedAt });
  if (pipe.fullAt) setPart('pipeline', { state: 'cached', at: pipe.ciAt || pipe.fullAt });
  if (mergedProgress().complete) setPart('activity', { state: 'cached', at: mergedStore.until });
  renderQueue();   // the rebase list and chains of the saved coordination issue
  renderParts();
  runSync();
  setInterval(() => {
    const now = Date.now();
    const due = now - sync.last >= syncEvery() || catchUpDue(now);
    if (document.hidden) {
      if (!sync.running && due && building()) runSync();
      return;
    }
    if (!sync.running && due) runSync();
    else { renderClock(); renderBanner(); renderParts(); }
  }, CLOCK_MS);
  document.addEventListener('click', e => {
    if (!e.target.closest('.pb-token')) return;
    bannerOffer = true;
    bannerClosed = '';
    bannerKey = null;
    renderBanner();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  for (const type of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'scroll', 'touchstart', 'focus']) {
    window.addEventListener(type, noteActivity, { passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // Back in view after the minute is up: update right away instead of waiting for the next tick.
    lastSeen = Date.now();
    if (!sync.running && Date.now() - sync.last >= SYNC_MS) runSync();
    else renderClock();
  });
}
