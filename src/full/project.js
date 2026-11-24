/*
 * The sections of a project dashboard whose Leonida version reads Leonida's own documents (README status table,
 * coordination issue, D3D12 tracker, design notes, security review table). For every other project they are built
 * from its entry on the shared ladder (CFG, written by build.py from projects.json) and from its own repository:
 *
 * - Road to playable: the ladder stages, done / here now / still ahead, with the project's own account at its stage.
 * - Blockers: where it stops today and the next stage; for a project that builds on another, how far apart they are.
 * - Graphics layer and How sure are we?: the facts read from its sources (graphics API, shader route, test machines,
 *   evidence and caveats).
 * - Security: its releases and what they ship, the things to check before running anything.
 * - Work board: its open issues by label (one core call, cached).
 *
 * Loaded after the inline script in page.html and uses its helpers: $, esc, md, fmt, ago, scrub, api, showError,
 * REPO, GH, CFG, SLOW_MS, STATUS_MS.
 */
'use strict';

const ISSUES_PAGE = 100;
const ISSUES_SHOWN_PER_LABEL = 6;
const LABELS_SHOWN = 8;
const RELEASES_SHOWN = 5;
const RUNNABLE_RE = /\.(exe|msi|dll|bat|cmd|ps1|scr|zip|7z|rar)$/i;

function ladderStages() {
  const here = CFG.ladder.findIndex(s => s.key === CFG.stage);
  return CFG.ladder.map((s, i) => ({
    key: s.key, title: s.label, plain: s.means, pct: s.pct,
    status: i < here ? 'done' : i === here ? 'wip' : 'todo',
    score: i < here ? 1 : i === here ? CFG.within : 0,
  }));
}

function renderLadderJourney(stages, pct) {
  const label = { done: 'Reached', wip: 'Here now', todo: 'Ahead' };
  const rows = stages.map((s, i) => `<div class="stage ${s.status}">
      <div class="ico" aria-hidden="true">${s.status === 'done' ? '✓' : s.status === 'wip' ? '▶' : i + 1}</div>
      <div><h4>${esc(s.title)} <small class="muted">${s.pct}%</small></h4><p>${esc(s.plain)}</p>
        <span class="pill ${s.status}">${label[s.status]}</span>
        ${s.status === 'wip' ? `<details class="more" open><summary>What the project says</summary><div>${esc(CFG.summary)}${CFG.caveat ? `<p class="muted">Caveat: ${esc(CFG.caveat)}</p>` : ''}</div></details>` : ''}
      </div></div>`).join('');
  $('#journeyBody').innerHTML = `<div class="acts"><article class="act" style="grid-column:1/-1">
      <div class="act-top"><div><div class="act-no">${esc(CFG.kindLabel)}</div><h3>${esc(CFG.name)} on the shared ladder</h3></div><div class="act-pct">${pct}%</div></div>
      <div class="meter"><i class="m-done" style="width:${stages.find(s => s.status === 'wip') ? stages.find(s => s.status === 'wip').pct : 100}%"></i><i class="m-wip" style="width:${Math.max(0, pct - (stages.find(s => s.status === 'wip') || { pct }).pct)}%"></i></div>
      ${rows}</article></div>
    <p class="footnote">How the ${pct}% is worked out: each stage has a fixed share of the way to playable (shown next to it), and a project gets part of the way to its next stage for how far it is compared with the others at the same stage. The stage itself is read by hand from the project's own sources on ${esc(CFG.checked)}, so it can lag behind its latest commits. <a href="../#method">The ladder, explained</a>.</p>`;
}

function renderLadderBlockers(stages) {
  const i = CFG.ladder.findIndex(s => s.key === CFG.stage);
  const next = CFG.ladder[i + 1];
  const where = `<div class="big-block"><div class="tag">Where it stops · by its own account</div>
      <h3>Reached: ${esc(CFG.stageLabel)}</h3>
      <p>${esc(CFG.summary)}</p>${CFG.caveat ? `<p class="muted">Caveat: ${esc(CFG.caveat)}</p>` : ''}</div>`;
  const ahead = next ? `<div class="big-block" style="border-color:rgba(255,182,72,.45)"><div class="tag" style="color:var(--wip)">Next on the ladder · ${next.pct}%</div>
      <h3>${esc(next.label)}</h3><p>${esc(next.means)}</p></div>` : '';
  const status = CFG.status === 'active' ? '' : `<p class="footnote">Status: <b>${esc(CFG.statusLabel)}</b>.</p>`;
  $('#blockersBody').innerHTML = `${where}${ahead}<div id="upstreamBox"></div>${status}`;
  if (CFG.base) renderUpstream().catch(e => showError('#upstreamBox', 'Could not compare with the project it builds on', e));
}

async function renderUpstream() {
  const [own, base] = await Promise.all([
    api(`/repos/${REPO}`, d => ({ branch: d.default_branch, pushed: d.pushed_at, fork: !!d.fork, parent: d.parent && d.parent.full_name }), 'up:own', { maxAge: SLOW_MS }),
    api(`/repos/${CFG.base.repo}`, d => ({ branch: d.default_branch, pushed: d.pushed_at }), 'up:base', { maxAge: SLOW_MS }),
  ]);
  const head = `${base.data.branch}...${REPO.split('/')[0]}:${REPO.split('/')[1]}:${own.data.branch}`;
  let cmp = null;
  try {
    cmp = (await api(`/repos/${CFG.base.repo}/compare/${head}`, d => ({ ahead: d.ahead_by, behind: d.behind_by }), 'up:cmp', { maxAge: STATUS_MS })).data;
  } catch (e) { if (!/404/.test(String(e && e.message))) throw e; }
  const line = `${esc(CFG.base.name)} last pushed ${esc(ago(base.data.pushed))}; ${esc(CFG.name)} ${esc(ago(own.data.pushed))}.`;
  $('#upstreamBox').innerHTML = cmp
    ? `<div class="big-block" style="border-color:rgba(46,230,200,.4)"><div class="tag" style="color:var(--teal)">Builds on ${esc(CFG.base.name)}</div>
        <h3>${fmt(cmp.ahead)} commits ahead, ${fmt(cmp.behind)} behind</h3><p>${line} <a href="../${esc(CFG.base.slug)}/">Its dashboard</a>.</p></div>`
    : `<div class="big-block" style="border-color:rgba(46,230,200,.4)"><div class="tag" style="color:var(--teal)">Builds on ${esc(CFG.base.name)}</div>
        <h3>Not a GitHub fork, so the histories can't be compared here</h3><p>${line} <a href="../${esc(CFG.base.slug)}/">Its dashboard</a>.</p></div>`;
}

function factList(rows) {
  const items = rows.filter(([, v]) => v).map(([k, v]) => `<div class="pf"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
  return items ? `<div class="pfacts">${items}</div>` : '<p class="muted">The project\'s sources don\'t say.</p>';
}

function renderProjectGraphics() {
  $('#graphicsBody').innerHTML = `<div class="card">${factList([
    ['Graphics API on the PC', CFG.backend], ['Console shaders become', CFG.shader_path],
    ['Tested on', CFG.tested_on], ['Written in', CFG.language],
  ])}<p class="footnote">The console's DirectX 12 and its precompiled GPU programs are the hardest part for every project: each one answers the calls with a PC graphics API and translates or recompiles the shaders. Read from ${esc(CFG.name)}'s sources on ${esc(CFG.checked)}.</p></div>`;
}

function renderProjectProof() {
  $('#proofBody').innerHTML = `<div class="card">${factList([
    ['Evidence for its stage', CFG.evidence], ['Caveat', CFG.caveat], ['Tested on', CFG.tested_on],
  ])}<p class="footnote">This page has not run the project. The stage counts what the project's own README, status notes or commits claim on the retail game; a vague or second-hand claim counts as the stage below. When a claim comes with a video, a screenshot or a second machine, it is stronger.</p></div>`;
}

async function renderReleases() {
  try {
    const r = await api(`/repos/${REPO}/releases?per_page=${RELEASES_SHOWN}`, d => d.map(x => ({
      name: scrub(x.name || x.tag_name), url: x.html_url, at: x.published_at, pre: x.prerelease,
      assets: (x.assets || []).map(a => ({ name: scrub(a.name), size: a.size, n: a.download_count })),
    })), 'releases', { maxAge: SLOW_MS });
    const list = r.data;
    const runnable = list.flatMap(x => x.assets).filter(a => RUNNABLE_RE.test(a.name));
    const intro = list.length
      ? `<p>${esc(CFG.name)} publishes releases on GitHub${runnable.length ? `, ${runnable.length} of their files are programs or archives you would run` : ''}. Only take them from <a href="${GH}/releases" target="_blank" rel="noopener">its own releases page</a>, never from a mirror, a DM or a video description.</p>`
      : `<p>${esc(CFG.name)} has no GitHub releases: it is built from source. Anything offered elsewhere as a ready-made build of it did not come from the project.</p>`;
    const rows = list.map(x => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name)}</a>${x.pre ? ' <span class="pill todo">pre-release</span>' : ''}
        <span class="muted"> · ${esc(ago(x.at))} · ${x.assets.length} file${x.assets.length === 1 ? '' : 's'}</span></li>`).join('');
    $('#securityBody').innerHTML = `<div class="card">${intro}${rows ? `<ul class="rel-list">${rows}</ul>` : ''}
      <p class="footnote">A clean virus scan is not proof: someone who wants to hack people can build something that scans clean. Build from the project's source when you can, and compare your game executable with the hashes in the Q&amp;A.</p></div>`;
  } catch (e) { showError('#securityBody', 'Could not read the releases', e); }
}

async function renderIssues() {
  try {
    const r = await api(`/repos/${REPO}/issues?state=open&sort=updated&per_page=${ISSUES_PAGE}`, d => d.filter(x => !x.pull_request).map(x => ({
      n: x.number, title: scrub(x.title), url: x.html_url, at: x.updated_at, user: scrub(x.user ? x.user.login : ''),
      labels: (x.labels || []).map(l => scrub(l.name)), comments: x.comments,
    })), 'issues', { maxAge: STATUS_MS });
    const issues = r.data;
    $('#claimLink').href = GH + '/issues';
    if (!issues.length) {
      $('#workBody').innerHTML = `<div class="card"><p>No open issues. ${esc(CFG.name)} may track its work elsewhere: see <a href="${GH}" target="_blank" rel="noopener">its README</a>.</p></div>`;
      return;
    }
    const groups = new Map();
    for (const it of issues) for (const l of (it.labels.length ? it.labels : ['no label'])) {
      if (!groups.has(l)) groups.set(l, []);
      groups.get(l).push(it);
    }
    const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, LABELS_SHOWN);
    const cols = ordered.map(([label, list]) => `<article class="card iss-col"><h3>${esc(label)} <small class="muted">${list.length}</small></h3><ol class="iss">${
      list.slice(0, ISSUES_SHOWN_PER_LABEL).map(it => `<li><a href="${esc(it.url)}" target="_blank" rel="noopener">#${it.n} ${esc(it.title)}</a><span class="muted">${esc(it.user)} · ${esc(ago(it.at))}${it.comments ? ` · 💬 ${it.comments}` : ''}</span></li>`).join('')
    }</ol></article>`).join('');
    $('#workBody').innerHTML = `<p class="footnote">${fmt(issues.length)}${issues.length >= ISSUES_PAGE ? '+' : ''} open issues, most recently active first.</p><div class="iss-grid">${cols}</div>`;
  } catch (e) { showError('#workBody', 'Could not read the issues', e); }
}
