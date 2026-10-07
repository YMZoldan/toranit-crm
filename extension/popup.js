(async () => {
  const c = await getCfg(), st = document.getElementById('st'), lg = document.getElementById('log');
  st.innerHTML = !c.key ? '<p class="bad">לא הוגדר מפתח. פתח את ההגדרות.</p>' : c.enabled ? '<p>פעיל עבור: ' + c.suppliers.map(s => s.name).join(', ') + '</p>' : '<p class="bad">השליחה האוטומטית כבויה.</p>';
  lg.innerHTML = (c.log || []).length ? c.log.slice(0, 8).map(e => '<div class="e"><b class="' + (e.ok ? 'ok' : 'bad') + '">' + (e.ok ? '✓ ' : '✕ ') + e.supplier + '</b> <small>' + new Date(e.at).toLocaleString('he-IL') + '</small><div><small>' + (e.file || '') + (e.error ? ' · ' + e.error : '') + '</small></div></div>').join('') : '<p><small>עדיין לא נשלחו מחירונים. הורד מחירון מפורטל של ספק.</small></p>';
  document.getElementById('opt').addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.getElementById('crm').addEventListener('click', () => chrome.tabs.create({ url: crmBase(c) }));
})();
