/* The race parts of this hand-made dashboard: the project switcher in the top bar and the milestone ladder under the
 * ring, both from the site's ../data.json (written by build.py), with the shared ../assets/ladder.js drawing the
 * ladder. This page's own ring is its milestone score; the ladder places it among the other projects. */
(function () {
  'use strict';
  const SLUG = CFG.slug;   // the page's project, from the config build.py writes
  const { esc } = window.Dash;

  function switcher(d) {
    const sel = document.getElementById('switcher');
    if (!sel) return;
    const byStage = {};
    for (const p of d.projects) (byStage[p.stage] = byStage[p.stage] || []).push(p);
    const groups = d.ladder.slice().reverse().map(s => {
      const members = (byStage[s.key] || []).sort((a, b) => b.within - a.within || a.name.localeCompare(b.name));
      if (!members.length) return '';
      return `<optgroup label="${esc(s.label)}">${members.map(p => `<option value="../${esc(p.slug)}/"${p.slug === SLUG ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</optgroup>`;
    }).join('');
    sel.innerHTML = `<option value="../">Standings: every project</option>${groups}`;
    sel.addEventListener('change', () => { if (sel.value) location.href = sel.value; });
  }

  function ladder(d) {
    const markers = d.standings.map(p => ({ name: p.name, score: p.score, avatar: p.avatar, href: `../${p.slug}/`, slug: p.slug }));
    const me = d.standings.find(p => p.slug === SLUG);
    window.Dash.ladder(document.getElementById('ladder'), d.ladder, markers, SLUG);
    const note = document.getElementById('ladderNote');
    if (note && me) {
      const leader = d.standings[0];
      note.innerHTML = `On the shared ladder: <b>#${me.rank} of ${d.standings.length}</b> at ${me.score}%` +
        (leader.slug === SLUG ? ', in the lead.' : `; the leader, <a href="../${esc(leader.slug)}/">${esc(leader.name)}</a>, is at ${leader.score}%.`) +
        ` <a href="../">All standings</a>`;
    }
  }

  fetch('../data.json')
    .then(r => (r.ok ? r.json() : Promise.reject(new Error('data.json answered ' + r.status))))
    .then(d => { switcher(d); ladder(d); })
    .catch(err => {
      console.warn('race: standings unavailable:', err.message);
      const host = document.getElementById('ladder');
      if (host) host.innerHTML = '<p class="busy">The standings could not be loaded. <a href="../">Open them</a></p>';
    });
})();
