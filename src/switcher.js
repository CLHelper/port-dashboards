/* The project switcher in the top bar: picking an entry opens that project's dashboard (or the standings). */
(function () {
  'use strict';
  const sel = document.getElementById('switcher');
  if (!sel) return;
  sel.addEventListener('change', () => { if (sel.value) location.href = sel.value; });
})();
