'use strict';
/*
 * "Can my PC run it?": pick a CPU, GPU and RAM and compare them with community ranges (hardware-model.js). The
 * curated picks below come first; hardware.json adds every other consumer model by name (TechAPI, CC BY-SA 4.0).
 * Nothing leaves the browser: no GitHub calls, no storage beyond the last choice.
 * Loaded after the inline script in index.html and uses its helpers: $, esc, store, GH.
 */

const HW_PICKS = {
  cpu: [
    ["Intel", [
      "Intel Core i5-11400F",
      "Intel Core Ultra 9 285K",
      "Intel Core Ultra 7 265K",
      "Intel Core Ultra 5 245K",
      "Intel Core i9-14900K / KF",
      "Intel Core i7-14700K / KF",
      "Intel Core i5-14600K / KF",
      "Intel Core i5-14400 / F",
      "Intel Core i9-13900K / KF",
      "Intel Core i7-13700K / KF",
      "Intel Core i5-13600K / KF",
      "Intel Core i5-13400 / F",
      "Intel Core i3-13100 / F",
      "Intel Core i9-12900K / KF",
      "Intel Core i7-12700K / KF",
      "Intel Core i5-12600K / KF",
      "Intel Core i5-12400 / F",
      "Intel Core i3-12100 / F",
      "Intel Core i7-11700 / K / F",
      "Intel Core i5-11320H",
      "Intel Core i5-11600K / KF",
      "Intel Core i5-11400F / 11400",
      "Intel Core i7-10700 / K / F",
      "Intel Core i5-10600K / KF",
      "Intel Core i5-10400 / F",
      "Intel Core i3-10100 / F",
      "Intel Core i9-9900K / KF",
      "Intel Core i7-9700K / KF",
      "Intel Core i7-8700K",
    ]],
    ["Intel laptop", [
      "Intel Core Ultra 9 285HX",
      "Intel Core Ultra 9 275HX",
      "Intel Core Ultra 7 265HX",
      "Intel Core Ultra 7 255HX",
      "Intel Core Ultra 5 245HX",
      "Intel Core Ultra 9 285H",
      "Intel Core Ultra 7 265H",
      "Intel Core Ultra 7 255H",
      "Intel Core Ultra 5 225H",
      "Intel Core i9-14900HX",
      "Intel Core i9-13980HX",
      "Intel Core i9-13900HX",
      "Intel Core i7-14700HX",
      "Intel Core i7-14650HX",
      "Intel Core i7-13700HX",
      "Intel Core i7-13650HX",
      "Intel Core i5-13500HX",
      "Intel Core i5-13450HX",
      "Intel Core i9-12900HX",
      "Intel Core i7-12800HX",
      "Intel Core i7-12700H",
      "Intel Core i9-13900H",
      "Intel Core i7-13700H",
      "Intel Core i7-13620H",
      "Intel Core i5-12500H",
      "Intel Core i5-12450H",
      "Intel Core i7-11800H",
      "Intel Core i5-11400H",
      "Intel Core i7-10875H",
      "Intel Core i5-10300H",
    ]],
    ["AMD", [
      "AMD Ryzen 7 9850X3D",
      "AMD Ryzen 9 9950X3D",
      "AMD Ryzen 7 9800X3D",
      "AMD Ryzen 7 9700X",
      "AMD Ryzen 5 9600X",
      "AMD Ryzen 9 7950X3D",
      "AMD Ryzen 7 7800X3D",
      "AMD Ryzen 7 7700 / X",
      "AMD Ryzen 5 7600X3D",
      "AMD Ryzen 5 7600 / X",
      "AMD Ryzen 5 7500F",
      "AMD Ryzen 7 5800X3D",
      "AMD Ryzen 7 5700X3D",
      "AMD Ryzen 7 5700X / 5800X",
      "AMD Ryzen 5 5600 / X",
      "AMD Ryzen 5 5600G / 5500",
      "AMD Ryzen 7 3700X",
      "AMD Ryzen 5 3600 / X",
      "AMD Ryzen 5 2600 / X",
      "AMD Ryzen 5 1600",
    ]],
    ["AMD laptop", [
      "AMD Ryzen 9 9955HX3D",
      "AMD Ryzen 9 9955HX",
      "AMD Ryzen 9 8945HX",
      "AMD Ryzen 9 7945HX3D",
      "AMD Ryzen 9 7945HX",
      "AMD Ryzen 9 7845HX",
      "AMD Ryzen 7 7745HX",
      "AMD Ryzen 5 7645HX",
      "AMD Ryzen AI 9 HX 370",
      "AMD Ryzen AI 9 HX 375",
      "AMD Ryzen AI 9 365",
      "AMD Ryzen AI 7 350",
      "AMD Ryzen 9 8945HS",
      "AMD Ryzen 7 8845HS",
      "AMD Ryzen 7 7840HS",
      "AMD Ryzen 7 6800H",
      "AMD Ryzen 7 5800H",
      "AMD Ryzen 5 6600H",
      "AMD Ryzen 5 5600H",
      "AMD Ryzen 7 4800H",
    ]],
  ],
  gpu: [
    ["NVIDIA GeForce", [
      "NVIDIA GeForce RTX 5090",
      "NVIDIA GeForce RTX 5080",
      "NVIDIA GeForce RTX 5070 Ti",
      "NVIDIA GeForce RTX 5070",
      "NVIDIA GeForce RTX 5060 Ti 16 GB",
      "NVIDIA GeForce RTX 5060 Ti 8 GB",
      "NVIDIA GeForce RTX 5060",
      "NVIDIA GeForce RTX 5050",
      "NVIDIA GeForce RTX 4090",
      "NVIDIA GeForce RTX 4080 Super",
      "NVIDIA GeForce RTX 4080",
      "NVIDIA GeForce RTX 4070 Ti Super",
      "NVIDIA GeForce RTX 4070 Ti",
      "NVIDIA GeForce RTX 4070 Super",
      "NVIDIA GeForce RTX 4070",
      "NVIDIA GeForce RTX 4060 Ti 16 GB",
      "NVIDIA GeForce RTX 4060 Ti 8 GB",
      "NVIDIA GeForce RTX 4060",
      "NVIDIA GeForce RTX 3090 Ti",
      "NVIDIA GeForce RTX 3090",
      "NVIDIA GeForce RTX 3080 Ti",
      "NVIDIA GeForce RTX 3080 10 GB",
      "NVIDIA GeForce RTX 3070 Ti",
      "NVIDIA GeForce RTX 3070 (8 GB VRAM)",
      "NVIDIA GeForce RTX 3060 Ti",
      "NVIDIA GeForce RTX 3060 12 GB",
      "NVIDIA GeForce RTX 3060 8 GB",
      "NVIDIA GeForce RTX 3050 8 GB",
      "NVIDIA GeForce RTX 3050 6 GB",
      "NVIDIA GeForce RTX 2080 Ti",
      "NVIDIA GeForce RTX 2080 Super",
      "NVIDIA GeForce RTX 2070 Super",
      "NVIDIA GeForce RTX 2070",
      "NVIDIA GeForce RTX 2060 Super",
      "NVIDIA GeForce GTX 1650 Super",
      "NVIDIA GeForce GTX 1660",
      "NVIDIA GeForce RTX 2060",
    ]],
    ["AMD Radeon", [
      "AMD Radeon RX 9070 XT",
      "AMD Radeon RX 9070",
      "AMD Radeon RX 9070 GRE",
      "AMD Radeon RX 9060 XT 16 GB",
      "AMD Radeon RX 9060 XT 8 GB",
      "AMD Radeon RX 7900 XTX",
      "AMD Radeon RX 7900 XT",
      "AMD Radeon RX 7900 GRE",
      "AMD Radeon RX 7800 XT",
      "AMD Radeon RX 7700 XT",
      "AMD Radeon RX 7600 XT",
      "AMD Radeon RX 7600",
      "AMD Radeon RX 6950 XT",
      "AMD Radeon RX 6900 XT",
      "AMD Radeon RX 6800 XT",
      "AMD Radeon RX 6800",
      "AMD Radeon RX 6750 XT",
      "AMD Radeon RX 6700 XT",
      "AMD Radeon RX 6700",
      "AMD Radeon RX 6650 XT",
      "AMD Radeon RX 6600 XT",
      "AMD Radeon RX 6600",
      "AMD Radeon RX 5500 XT",
      "AMD Radeon RX 6500 XT",
    ]],
    ["Intel Arc", [
      "Intel Arc B580",
      "Intel Arc B570",
      "Intel Arc A770 16 GB",
      "Intel Arc A750",
    ]],
    ["NVIDIA laptop GPUs", [
      "NVIDIA GeForce RTX 5090 Laptop (24 GB)",
      "NVIDIA GeForce RTX 5080 Laptop (16 GB)",
      "NVIDIA GeForce RTX 5070 Ti Laptop (12 GB)",
      "NVIDIA GeForce RTX 5070 Laptop (8 GB)",
      "NVIDIA GeForce RTX 5060 Laptop (8 GB)",
      "NVIDIA GeForce RTX 5050 Laptop (8 GB)",
      "NVIDIA GeForce RTX 4090 Laptop (16 GB)",
      "NVIDIA GeForce RTX 4080 Laptop (12 GB)",
      "NVIDIA GeForce RTX 4070 Laptop (8 GB)",
      "NVIDIA GeForce RTX 4060 Laptop (8 GB)",
      "NVIDIA GeForce RTX 4050 Laptop (6 GB)",
      "NVIDIA GeForce RTX 3080 Ti Laptop (16 GB)",
      "NVIDIA GeForce RTX 3080 Laptop (8 GB)",
      "NVIDIA GeForce RTX 3070 Ti Laptop (8 GB)",
      "NVIDIA GeForce RTX 3070 Laptop (8 GB)",
      "NVIDIA GeForce RTX 3060 Laptop (6 GB)",
      "NVIDIA GeForce RTX 3050 Ti Laptop (4 GB)",
      "NVIDIA GeForce RTX 3050 Laptop (6 GB)",
      "NVIDIA GeForce RTX 2080 Super Laptop (8 GB)",
      "NVIDIA GeForce RTX 2080 Laptop (8 GB)",
      "NVIDIA GeForce RTX 2070 Super Laptop (8 GB)",
      "NVIDIA GeForce RTX 2070 Laptop (8 GB)",
      "NVIDIA GeForce RTX 2060 Laptop (6 GB)",
      "NVIDIA GeForce RTX 2050 Laptop (4 GB)",
      "NVIDIA GeForce GTX 1660 Ti Laptop (6 GB)",
      "NVIDIA GeForce GTX 1650 Ti Laptop (4 GB)",
      "NVIDIA GeForce GTX 1650 Laptop (4 GB)",
      "NVIDIA GeForce GTX 1070 Laptop (8 GB)",
      "NVIDIA GeForce GTX 1060 Laptop (6 GB)",
    ]],
    ["AMD laptop GPUs", [
      "AMD Radeon RX 7900M (16 GB)",
      "AMD Radeon RX 6850M XT (12 GB)",
      "AMD Radeon RX 6800M (12 GB)",
      "AMD Radeon RX 6700M (10 GB)",
      "AMD Radeon RX 7700S (8 GB)",
      "AMD Radeon RX 7600M XT (8 GB)",
      "AMD Radeon RX 7600M (8 GB)",
      "AMD Radeon RX 7600S (8 GB)",
      "AMD Radeon RX 6800S (8 GB)",
      "AMD Radeon RX 6700S (8 GB)",
      "AMD Radeon RX 6600M (8 GB)",
    ]],
    ["Integrated graphics", [
      "AMD Radeon 8060S",
      "AMD Radeon 8050S",
      "AMD Radeon 890M",
      "AMD Radeon 880M",
      "AMD Radeon 780M",
      "AMD Radeon 760M",
      "AMD Radeon 680M",
      "AMD Radeon 660M",
      "AMD Radeon Vega 8",
      "Intel Arc Graphics 140V",
      "Intel Arc Graphics 140T",
      "Intel Arc Graphics 130V",
      "Intel Iris Xe Graphics",
    ]],
  ],
};
const HW_DEFAULT = { cpu: 'Intel Core i5-11400F', gpu: 'NVIDIA GeForce RTX 3070 (8 GB VRAM)' };
const HW_KEY = 'hardware:v1';
const HW_CUSTOM = 'custom';
const HW_RAM_PRESETS = [4, 8, 12, 16, 24, 32, 48, 64, 96, 128];
const HW_NAME_MAX = 180;
const HW_REFERENCES = {
  'series-x': { name: 'Xbox Series X', label: 'Community Xbox Series X comparison', CPU: 'Ryzen 7 3700X or Ryzen 5 5600', GPU: 'RTX 3060 Ti / 3070 or RX 6700 XT / 6800', RAM: '32 GB suggested for PCs' },
  ps5: { name: 'PS5', label: 'Community PS5 comparison', CPU: 'Ryzen 7 3700X class', GPU: 'RTX 2070 Super / 3070 or RX 6700 XT', RAM: '32 GB suggested for PCs' },
  'ps5-pro': { name: 'PS5 Pro', label: 'Community PS5 Pro comparison', CPU: 'Ryzen 7 3700X to 5700X class', GPU: 'RTX 5060 Ti 16 GB or RX 9060 XT 16 GB', RAM: '32 GB suggested for PCs' },
  'series-s': { name: 'Xbox Series S', label: 'Community Xbox Series S comparison', CPU: 'Ryzen 5 3600 class', GPU: 'GTX 1650 Super / 1660 or RX 5500 XT', RAM: '32 GB suggested for PCs' },
  low: { name: 'Community estimate for 1080p Low', label: 'Community estimate for 1080p Low', CPU: 'i5-12400F or Ryzen 5 5600', GPU: 'RTX 3060 8 GB, RX 6600 or Arc A750 (ray tracing)', RAM: '16 GB' },
};
const HW_STATUS = { above: 'Above', near: 'In range', below: 'Below', unknown: 'Unknown', empty: '–', outside: 'ARM', uncertain: 'Uncertain' };

/** The picker's options: curated groups, then the catalog sorted by brand and series, then "Enter another model…". */
function hwOptions(kind, catalog) {
  const groups = HW_PICKS[kind].map(([label, names]) => ({ label, names }));
  const known = new Set(groups.flatMap(g => g.names.map(n => n.toLowerCase())));
  const extra = (Array.isArray(catalog) ? catalog : [])
    .filter(n => typeof n === 'string' && n.length <= HW_NAME_MAX && !known.has(n.toLowerCase()));
  const sections = HW.hardwareSections(extra, kind).map(s => ({ label: `${s.label} · comparison may be unavailable`, names: s.names }));
  return [...groups, ...sections];
}

function hwSelectHtml(groups, selected, query) {
  const shown = groups
    .map(g => ({ label: g.label, names: g.names.filter(n => n === selected || HW.matchesModel(n, query)) }))
    .filter(g => g.names.length);
  const opts = shown.map(g => `<optgroup label="${esc(g.label)}">${g.names.map(n => `<option value="${esc(n)}"${n === selected ? ' selected' : ''}>${esc(n)}</option>`).join('')}</optgroup>`).join('');
  return { html: `${opts}<option value="${HW_CUSTOM}"${selected === HW_CUSTOM ? ' selected' : ''}>Enter another model…</option>`, count: shown.reduce((a, g) => a + g.names.length, 0) };
}

const hw = { groups: { cpu: [], gpu: [] }, total: { cpu: 0, gpu: 0 } };

function hwPicker(kind, title, example) {
  return `<label class="hw-field">${esc(title)}
      <input class="hw-search" type="search" id="hw-${kind}-q" placeholder="Search ${esc(title)}" aria-label="Search ${esc(title)}" autocomplete="off" spellcheck="false">
      <select id="hw-${kind}" aria-label="${esc(title)}"></select>
      <span class="hw-count" id="hw-${kind}-count" role="status"></span>
    </label>
    <label class="hw-field" id="hw-${kind}-custom-row" hidden>Your ${esc(title)}
      <input type="text" id="hw-${kind}-custom" placeholder="e.g. ${esc(example)}" autocomplete="off" spellcheck="false" maxlength="${HW_NAME_MAX}">
    </label>`;
}

function hwForm() {
  const refs = Object.entries(HW_REFERENCES).map(([k, r]) => `<option value="${k}">${esc(r.name)}</option>`).join('');
  return `<div class="hw">
    <form class="card hw-form" id="hwForm" aria-label="Your PC">
      <label class="hw-field">Compare to<select id="hw-ref">${refs}</select></label>
      ${hwPicker('cpu', 'CPU', 'Intel Core i5-11400F')}
      ${hwPicker('gpu', 'GPU', 'NVIDIA RTX 3070')}
      <label class="hw-field">RAM type<select id="hw-ramtype"><option value="ddr4">DDR4</option><option value="ddr5">DDR5</option></select></label>
      <div class="hw-field">
        <div class="hw-ram-top"><label for="hw-ram-slider">RAM</label>
          <span><input id="hw-ram" type="number" min="1" step="any" inputmode="decimal" value="32" aria-label="RAM in GB"> GB</span></div>
        <input id="hw-ram-slider" type="range" min="0" max="${HW_RAM_PRESETS.length - 1}" step="1" value="5" aria-valuetext="32 GB">
      </div>
    </form>
    <div class="card hw-result" role="status" aria-atomic="true">
      <b class="hw-verdict" id="hw-verdict">Checking…</b>
      <div class="of" id="hw-label"></div>
      <p class="hw-reason" id="hw-reason" hidden></p>
      <dl class="hw-rows">
        <div><dt>CPU <span id="hw-ref-CPU"></span></dt><dd id="hw-CPU">–</dd></div>
        <div><dt>GPU <span id="hw-ref-GPU"></span></dt><dd id="hw-GPU">–</dd></div>
        <div><dt>RAM <span id="hw-ref-RAM"></span></dt><dd id="hw-RAM">–</dd></div>
      </dl>
      <p class="hw-note" id="hw-tested" hidden></p>
      <p class="hw-note" id="hw-vram" hidden></p>
      <p class="footnote">An unofficial estimate from community predictions and general PC benchmarks. The port can't start the game yet, so nobody has measured how well it runs on any PC.</p>
      <details class="hw-sources"><summary>Sources</summary>
        <p>The console comparisons use approximate PC equivalents; 32 GB of DDR4 is suggested, and DDR5 uses 16 GB as a provisional floor. Console shared memory and PC RAM are not the same arrangement. Laptop parts are compared with the closest desktop model, so power limits and cooling make them approximate. 1080p Low uses the RTX 3060 8 GB / RX 6600 / Arc A750 range proposed by Silliana: a prediction, not a tested minimum. "Shader tests ran" comes from the GPU results posted in an issue of the original repository (the list is kept here); new results go in <a href="${GH}/tree/${BRANCH}/gpu-test-results" target="_blank" rel="noopener">gpu-test-results/</a>.</p>
        <ul>
          <li>Hardware names: <a href="https://github.com/GetTechAPI/TechAPI" target="_blank" rel="noopener">data from TechAPI</a>, <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener">CC BY-SA 4.0</a>; names only, no benchmark scores</li>
          <li><a href="https://www.xbox.com/en-US/consoles/xbox-series-x#tech-specs" target="_blank" rel="noopener">Xbox Series X specs</a></li>
          <li><a href="https://www.tomshardware.com/reviews/cpu-hierarchy,4312-2.html" target="_blank" rel="noopener">CPU</a> and <a href="https://www.tomshardware.com/reviews/gpu-hierarchy,4388.html" target="_blank" rel="noopener">GPU</a> benchmark rankings</li>
          <li><a href="https://www.notebookcheck.net/Mobile-Processors-Benchmark-List.2436.0.html" target="_blank" rel="noopener">Laptop CPU</a> and <a href="https://www.notebookcheck.net/Mobile-Graphics-Cards-Benchmark-List.844.0.html" target="_blank" rel="noopener">laptop GPU</a> benchmarks</li>
        </ul>
      </details>
    </div></div>`;
}

function hwFill(kind, selected) {
  const q = $(`#hw-${kind}-q`).value.trim();
  const { html, count } = hwSelectHtml(hw.groups[kind], selected, q);
  $(`#hw-${kind}`).innerHTML = html;
  $(`#hw-${kind}`).value = selected;
  $(`#hw-${kind}-count`).textContent = q ? (count ? `${count} matches, choose below` : 'No matches: choose "Enter another model…"') : `${hw.total[kind]} models`;
}

function hwChoice(kind) {
  const value = $(`#hw-${kind}`).value;
  const custom = value === HW_CUSTOM;
  $(`#hw-${kind}-custom-row`).hidden = !custom;
  return custom ? $(`#hw-${kind}-custom`).value.slice(0, HW_NAME_MAX) : value;
}

function hwSet(el, text) { if (el.textContent !== text) el.textContent = text; }

function hwUpdate() {
  const ref = $('#hw-ref').value;
  const base = HW_REFERENCES[ref];
  const ramType = $('#hw-ramtype').value;
  const ram = $('#hw-ram').value;
  const cpu = hwChoice('cpu');
  const gpu = hwChoice('gpu');
  const consoleRef = ref !== 'low';
  const r = HW.assessHardware(cpu, gpu, ram, ref, ramType);
  hwSet($('#hw-verdict'), r.verdict);
  $('#hw-verdict').dataset.tone = /could run|above/i.test(r.verdict) ? 'good' : /below|struggle|outside/i.test(r.verdict) ? 'bad' : 'mid';
  hwSet($('#hw-label'), base.label);
  const names = { CPU: cpu.trim(), GPU: gpu.trim(), RAM: `${ram} GB of RAM` };
  const list = parts => new Intl.ListFormat('en').format(parts);
  const below = Object.keys(names).filter(p => r.statuses[p] === 'below');
  const unknown = Object.keys(names).filter(p => r.statuses[p] === 'unknown');
  const against = consoleRef ? 'the reference range' : 'the estimate';
  let reason = '';
  if (r.statuses.CPU === 'outside' || r.statuses.GPU === 'outside') reason = 'The port targets Windows PCs with x64 processors.';
  else if (below.length === 1) reason = `${names[below[0]]} falls below ${against}.`;
  else if (below.length > 1) reason = `Below ${against} for ${list(below)}.`;
  if (unknown.length) reason += `${reason ? ' ' : ''}No reliable comparison yet for ${list(unknown.map(p => names[p]))}.`;
  $('#hw-reason').hidden = !reason;
  hwSet($('#hw-reason'), reason);
  const ramRef = ramType === 'ddr5' ? 'DDR5 · 16 GB provisional floor' : consoleRef ? '32 GB DDR4 suggested' : '16 GB DDR4 estimate';
  for (const part of ['CPU', 'GPU', 'RAM']) {
    hwSet($(`#hw-ref-${part}`), part === 'RAM' ? ramRef : base[part]);
    const dd = $(`#hw-${part}`);
    dd.dataset.status = r.statuses[part];
    hwSet(dd, HW_STATUS[r.statuses[part]] || '–');
  }
  const tested = gpu.trim() ? HW.shaderTestPlatform(gpu) : null;
  $('#hw-tested').hidden = !tested;
  hwSet($('#hw-tested'), tested ? `The project's shader tests ran on this GPU (${tested}).` : '');
  const vram = HW.graphicsMemory(gpu);
  const vramNote = !consoleRef && vram && Number(vram) < 8 ? `VRAM: ${vram} GB selected, 8 GB on the reference card.` : '';
  $('#hw-vram').hidden = !vramNote;
  hwSet($('#hw-vram'), vramNote);
  store.set(HW_KEY, { ref, cpu: $('#hw-cpu').value, gpu: $('#hw-gpu').value, ramType, ram });
}

function hwSyncSlider() {
  const amount = Number($('#hw-ram').value);
  if (!Number.isFinite(amount)) return;
  const nearest = HW_RAM_PRESETS.reduce((best, size, i) => (Math.abs(size - amount) < Math.abs(HW_RAM_PRESETS[best] - amount) ? i : best), 0);
  $('#hw-ram-slider').value = String(nearest);
  $('#hw-ram-slider').setAttribute('aria-valuetext', `${amount} GB`);
}

async function hwCatalog() {
  try {
    const res = await fetch('hardware.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } catch (e) {
    console.warn('[dashboard] hardware catalog unavailable; the curated picks and manual entry still work', e);
    return {};
  }
}

async function startHardware() {
  const box = $('#hardwareBody');
  if (!box || !HW_PICKS) return;
  box.innerHTML = hwForm();
  const catalog = await hwCatalog();
  const saved = store.get(HW_KEY) || {};
  for (const kind of ['cpu', 'gpu']) {
    hw.groups[kind] = hwOptions(kind, catalog[kind]);
    hw.total[kind] = hw.groups[kind].reduce((a, g) => a + g.names.length, 0);
    const all = new Set(hw.groups[kind].flatMap(g => g.names));
    hwFill(kind, all.has(saved[kind]) || saved[kind] === HW_CUSTOM ? saved[kind] : HW_DEFAULT[kind]);
    $(`#hw-${kind}-q`).addEventListener('input', () => { hwFill(kind, $(`#hw-${kind}`).value); hwUpdate(); });
  }
  if (HW_REFERENCES[saved.ref]) $('#hw-ref').value = saved.ref;
  if (saved.ramType === 'ddr4' || saved.ramType === 'ddr5') $('#hw-ramtype').value = saved.ramType;
  if (Number(saved.ram) > 0) $('#hw-ram').value = String(saved.ram);
  hwSyncSlider();
  const form = $('#hwForm');
  form.addEventListener('input', e => {
    if (e.target.id === 'hw-ram-slider') {
      const gb = HW_RAM_PRESETS[Number(e.target.value)];
      $('#hw-ram').value = String(gb);
      e.target.setAttribute('aria-valuetext', `${gb} GB`);
    } else if (e.target.id === 'hw-ram') hwSyncSlider();
    hwUpdate();
  });
  form.addEventListener('change', hwUpdate);
  form.addEventListener('submit', e => e.preventDefault());
  hwUpdate();
}
document.addEventListener('DOMContentLoaded', startHardware);
