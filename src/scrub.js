/* Masks the game's title, studio, publisher and places in text that comes from GitHub (commit messages, pull
 * request titles, descriptions), and drops links whose address names them. The patterns use \x escapes on purpose,
 * so the names never appear in this file's source. Shared by every page; window.Dash.scrub. */
(function () {
  'use strict';
  const NAMED = /g\x74a|gr\x61nd[\s_%20.-]*the\x66t|ro\x63kstar|t\x61ke[\s_-]?two|vi\x63e[\s_-]?city/i;
  const RULES = [
    [/\b(?:gr\x61nd\s+the\x66t\s+au\x74o|g\x74a)(?:[\s:-]*(?:vi|v|iv|6|5|six))?\b(?:'s)?/gi, 'The Game'],
    [/\bro\x63kstar(?:\s+(?:games|north|toronto|india|leeds|lincoln|london|new england|san diego|dundee))?\b/gi, 'the studio'],
    [/\bt\x61ke[\s-]?two(?:\s+interactive)?\b/gi, 'the publisher'],
    [/\bvi\x63e[\s_-]?city\b/gi, 'the city'],
    [/gr\x61nd[\s_.-]*the\x66t[\s_.-]*au\x74o|ro\x63kstar|t\x61ke[\s_-]?two|vi\x63e[\s_-]?city/gi, '***'],
    [/g\x74a[\s_.-]?(?:vi|6)|g\x74a/gi, '***'],
  ];
  function scrub(text) {
    if (typeof text !== 'string' || !NAMED.test(text)) return text;
    let s = text
      .replace(/\[([^\]]*)\]\(([^)]*)\)/g, (m, label, url) => (NAMED.test(url) ? label : m))
      .replace(/https?:\/\/[^\s)>"'\]]+/g, url => (NAMED.test(url) ? '(link removed)' : url));
    for (const [re, to] of RULES) s = s.replace(re, to);
    return s;
  }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
    if (!isFinite(s)) return '';
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function data() {
    const el = document.getElementById('data');
    return el ? JSON.parse(el.textContent) : null;
  }
  window.Dash = Object.assign(window.Dash || {}, { scrub, esc, ago, data, NAMED });
})();
