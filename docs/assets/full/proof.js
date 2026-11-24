'use strict';
/*
 * "How sure are we?": how the translator's contract rows were confirmed, and how many imports still have no binding.
 * Reads docs/design.md and docs/runtime_imports.md from the branch through raw.githubusercontent.com (no rate limit),
 * every PROOF_MS while the tab is visible. Only the counts are kept in the browser, not the documents (design.md is
 * over half a megabyte). The rules follow tools/progress_dashboard.py (CONFIRMATION, OPEN, collect_imports), so the
 * page and the tool count the same way.
 * Loaded after the inline script in index.html and uses its helpers: $, esc, fmt, scrub, store, REPO, BRANCH, GH,
 * cacheOnly.
 */

const PROOF_KEY = 'proof:v1';
const PROOF_MS = 30 * 60 * 1000;
const PROOF_TICK_MS = 60 * 1000;
const PROOF_LIST = 12;                 // rows shown per list before "and N more"

// How a contract row says it was confirmed. The first matching rule decides (tools/progress_dashboard.py).
const CONFIRMATION = [
  ['not_gpu', /not yet GPU-(?:verified|checked)|Unmeasured|still needs an? [^.]{0,40}(?:GPU|part)|no GPU measurement/i],
  ['gpu', /GPU-checked|GPU-verified|measured on (?:an? )?(?:gfx\d+|AMD|NVIDIA|Intel|Apple|RX |RTX |GeForce|Radeon)|run_gpu_tests|on an? (?:AMD|NVIDIA|Intel|Apple) [^.]{0,30}(?:GPU|Radeon|GeForce|RTX|RX|Arc|M\d)/i],
  ['reference', /Source: (?:LLVM|Mesa)|LLVM `|Mesa `|llvm-mc|ACO|RADV/i],
  ['corpus', /\bcorpus\b|of the 26,\d{3}|over (?:all|the) [\d,]+ shaders/i],
  ['cpu', /CPU-checked|CPU reference|unit test|tests\/semantic|exact-arithmetic model/i],
];
const OPEN_ITEMS = /\bstill open\b|\bremains? open\b|\bopen items?\b/i;
// Strongest first; the bar and the legend follow this order.
const KINDS = [
  { key: 'gpu', label: 'Proven on a real GPU', color: 'var(--done)' },
  { key: 'gpu+open', label: 'On a GPU, items still open', color: '#8ff7e6' },
  { key: 'reference', label: 'Matches LLVM or Mesa', color: 'var(--research)' },
  { key: 'corpus', label: 'Counted over every shader', color: 'var(--violet)' },
  { key: 'cpu', label: 'CPU test only', color: 'var(--wip)' },
  { key: 'not_gpu', label: 'Waiting for a GPU test', color: 'var(--todo)' },
  { key: 'unstated', label: 'Not stated', color: 'rgba(255,255,255,.18)' },
];

/** Cells of one Markdown table row; a | inside backticks stays in its cell. */
function proofCells(line) {
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out = [];
  let buf = '';
  let tick = false;
  for (const ch of s) {
    if (ch === '`') tick = !tick;
    if (ch === '|' && !tick) { out.push(buf.trim()); buf = ''; } else buf += ch;
  }
  out.push(buf.trim());
  return out;
}

/** Every pipe table: { heading, header, rows, section } with the text since the last heading in `section`. */
function proofTables(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const sep = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
  const out = [];
  let heading = null;
  let section = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.startsWith('#')) { heading = ln.replace(/^#+/, '').trim(); section = []; continue; }
    if (ln.trimStart().startsWith('|') && i + 1 < lines.length && sep.test(lines[i + 1])) {
      const header = proofCells(ln);
      const rows = [];
      let j = i + 2;
      for (; j < lines.length && lines[j].trimStart().startsWith('|'); j++) rows.push(proofCells(lines[j]));
      out.push({ heading, header, rows, section: section.join('\n') });
      i = j - 1;
      continue;
    }
    section.push(ln);
  }
  return out;
}

const proofPlain = s => String(s ?? '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*|`/g, '').trim();

function classifyContract(text) {
  const rule = CONFIRMATION.find(([, re]) => re.test(text));
  const kind = rule ? rule[0] : 'unstated';
  return kind === 'gpu' && OPEN_ITEMS.test(text) ? 'gpu+open' : kind;
}

/** The contract table in docs/design.md: rows per confirmation kind, and which pieces wait for a GPU or say nothing. */
function parseContract(text) {
  const table = proofTables(text).find(t => t.heading && /contract/i.test(t.heading));
  if (!table) throw new Error('docs/design.md has no table under a "contract" heading');
  const counts = Object.fromEntries(KINDS.map(k => [k.key, 0]));
  const waiting = [];
  const unstated = [];
  let total = 0;
  for (const row of table.rows) {
    if (row.length < 2) continue;
    const kind = classifyContract(proofPlain(row.slice(1).join(' ')));
    counts[kind]++;
    total++;
    const piece = proofPlain(row[0]).slice(0, 120);
    if (kind === 'not_gpu') waiting.push(piece);
    else if (kind === 'unstated') unstated.push(piece);
  }
  return { total, counts, waiting, unstated };
}

const proofNumber = s => {
  const t = proofPlain(s).replace(/,/g, '');
  return /^\d+$/.test(t) ? Number(t) : null;
};

/**
 * docs/runtime_imports.md: the package DLLs' import table (consumer, import, binding), the per-image counts, and the
 * game executable's own row under the retail executable's heading.
 */
function parseImports(text) {
  const out = { bindings: null, images: null, exe: null };
  for (const t of proofTables(text)) {
    const h = t.header.map(c => proofPlain(c).toLowerCase());
    if (h.includes('binding') && h.includes('import')) {
      const bi = h.indexOf('binding');
      const rows = t.rows.filter(r => r.length > bi);
      const missing = rows.filter(r => { const b = proofPlain(r[bi]).toLowerCase(); return b.includes('unimpl') || b === 'none' || b === 'missing'; }).length;
      out.bindings = { total: rows.length, bound: rows.length - missing };
    } else if (h.includes('unimplemented') && h.includes('image')) {
      const ui = h.indexOf('unimplemented');
      const ii = h.indexOf('image');
      const col = name => h.indexOf(name);
      const rows = t.rows.filter(r => proofNumber(r[ui]) !== null);
      if (t.heading && /retail executable/i.test(t.heading)) {
        const exe = rows.find(r => /\.exe\b/i.test(proofPlain(r[ii])));
        if (!exe) continue;
        const at = t.section.match(/Measured at `([0-9a-f]{7,40})`/i);
        const n = name => (col(name) >= 0 ? proofNumber(exe[col(name)]) : null);
        out.exe = { unimplemented: n('unimplemented'), shim: n('shim'), host: n('host'), module: n('module'), at: at ? at[1] : null };
      } else if (!out.images) {
        out.images = { total: rows.length, clean: rows.filter(r => proofNumber(r[ui]) === 0).length };
      }
    }
  }
  return out;
}

async function proofText(path) {
  const { res, text } = await fetchTimed(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/${path}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load ${path} (HTTP ${res.status})`);
  return text();
}

const proofState = { at: 0, busy: false };

async function loadProof() {
  if (proofState.busy) return;
  proofState.busy = true;
  try {
    const [design, imports] = await Promise.all([proofText('docs/design.md'), proofText('docs/runtime_imports.md')]);
    const data = { contract: parseContract(design), imports: parseImports(imports), at: Date.now(), branch: BRANCH };
    store.set(PROOF_KEY, data);
    proofState.at = data.at;
    renderProof(data);
  } catch (e) {
    console.error('[dashboard] proof', e);
    if (!proofState.at) $('#proofBody').innerHTML = `<div class="err-box"><b>Could not read the project's documents</b><br>${esc(e.message)}. It retries in a minute.</div>`;
    proofState.at = 0;
  } finally {
    proofState.busy = false;
  }
}

function proofList(items, empty) {
  if (!items.length) return `<p class="footnote">${esc(empty)}</p>`;
  const shown = items.slice(0, PROOF_LIST).map(p => `<li>${esc(scrub(p))}</li>`).join('');
  const more = items.length > PROOF_LIST ? `<li class="more">and ${fmt(items.length - PROOF_LIST)} more</li>` : '';
  return `<ul class="proof-list">${shown}${more}</ul>`;
}

function renderProof(d) {
  const c = d.contract;
  const pct = n => (c.total ? (n / c.total * 100) : 0);
  const gpu = c.counts.gpu;
  const bar = KINDS.filter(k => c.counts[k.key]).map(k => `<i style="width:${pct(c.counts[k.key]).toFixed(1)}%;background:${k.color}" title="${esc(`${k.label}: ${c.counts[k.key]}`)}"></i>`).join('');
  const legend = KINDS.filter(k => c.counts[k.key]).map(k => `<span><i style="background:${k.color}"></i>${esc(k.label)} <b>${fmt(c.counts[k.key])}</b></span>`).join('');
  const im = d.imports;
  const exe = im.exe;
  const exeHtml = exe && exe.unimplemented !== null
    ? `<div class="proof-num"><b class="${exe.unimplemented ? 'bad' : 'good'}">${fmt(exe.unimplemented)}</b><span>imports of the game's own executable still have no stand-in${exe.at ? ` (measured at <code>${esc(exe.at)}</code>)` : ''}</span></div>
       <p class="footnote">The others are answered by a shim (${fmt(exe.shim)}), the PC's own Windows (${fmt(exe.host)}) or a DLL from the package (${fmt(exe.module)}).</p>`
    : '<p class="footnote">The game executable\'s row was not found in the document.</p>';
  const dllHtml = im.images
    ? `<div class="proof-num"><b class="${im.images.clean === im.images.total ? 'good' : 'bad'}">${fmt(im.images.clean)}/${fmt(im.images.total)}</b><span>of the package's own DLLs load with every import answered</span></div>`
    : '';
  const bindHtml = im.bindings
    ? `<p class="footnote">${fmt(im.bindings.bound)} of ${fmt(im.bindings.total)} listed DLL imports have a binding.</p>`
    : '';
  $('#proofBody').innerHTML = `<div class="gfx">
    <div class="card gfx-big">
      <b>${Math.round(pct(gpu))}%</b><div class="of">of the translator's rules are proven on a real graphics card (${fmt(gpu)} of ${fmt(c.total)})</div>
      <div class="stack proof-stack" role="img" aria-label="${esc(KINDS.filter(k => c.counts[k.key]).map(k => `${k.label}: ${c.counts[k.key]}`).join(', '))}">${bar}</div>
      <div class="legend proof-legend">${legend}</div>
      <div class="subhead">Waiting for a GPU test</div>
      ${proofList(c.waiting, 'None: every rule that needs a GPU measurement has one.')}
      <p class="footnote">A good first task for anyone with a graphics card: each one needs a small test program, no game files.</p>
    </div>
    <div class="card">
      <div class="subhead" style="margin-top:0">Standing in for the console</div>
      ${exeHtml}
      ${dllHtml}
      ${bindHtml}
      <div class="subhead">Rules that don't say how they were checked</div>
      ${proofList(c.unstated, 'None.')}
      <p class="footnote">Read from <a href="${GH}/blob/${esc(BRANCH)}/docs/design.md#translator-status-and-runtime-contract" target="_blank" rel="noopener">the contract table ↗</a> and <a href="${GH}/blob/${esc(BRANCH)}/docs/runtime_imports.md" target="_blank" rel="noopener">the measured imports ↗</a> on <code>${esc(d.branch || BRANCH)}</code>, every 30 minutes, with the rules of <code>tools/progress_dashboard.py</code>. Updated ${esc(ago(d.at))}.</p>
    </div></div>`;
}

function startProof() {
  if (!$('#proofBody')) return;
  const saved = store.get(PROOF_KEY);
  if (saved && saved.contract && saved.branch === BRANCH) {
    renderProof(saved);
    proofState.at = saved.at;
  }
  const due = () => !document.hidden && !proofState.busy && Date.now() - proofState.at >= PROOF_MS;
  if (due()) loadProof();
  setInterval(() => { if (due()) loadProof(); }, PROOF_TICK_MS);
  document.addEventListener('visibilitychange', () => { if (due()) loadProof(); });
}
document.addEventListener('DOMContentLoaded', startProof);
