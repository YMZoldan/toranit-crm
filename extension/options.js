const $ = s => document.querySelector(s);
const msg = (t, ok) => { const m = $('#msg'); m.textContent = t; m.className = ok ? 'ok' : 'bad'; };
function row(s) {
  const tr = document.createElement('tr');
  tr.innerHTML = '<td><input type="text" dir="ltr" class="d" placeholder="example.co.il"></td><td><input type="text" class="n" placeholder="שם הספק"></td><td><button class="x" title="הסר">✕</button></td>';
  tr.querySelector('.d').value = s.domain || ''; tr.querySelector('.n').value = s.name || '';
  tr.querySelector('.x').addEventListener('click', () => tr.remove());
  $('#sup tbody').appendChild(tr);
}
async function load() {
  const c = await getCfg();
  $('#crm').value = c.crm; $('#key').value = c.key; $('#enabled').checked = !!c.enabled;
  $('#sup tbody').innerHTML = ''; (c.suppliers || []).forEach(row);
}
function collect() {
  const suppliers = [...document.querySelectorAll('#sup tbody tr')].map(tr => ({ domain: tr.querySelector('.d').value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''), name: tr.querySelector('.n').value.trim() })).filter(s => s.domain && s.name);
  return { crm: $('#crm').value.trim().replace(/\/+$/, ''), key: $('#key').value.trim(), enabled: $('#enabled').checked, suppliers };
}
async function ensurePerms(c) {
  const origins = [c.crm + '/*'].concat(c.suppliers.map(s => 'https://*.' + s.domain + '/*'));
  const has = await chrome.permissions.contains({ origins });
  return has || chrome.permissions.request({ origins });
}
$('#add').addEventListener('click', () => row({}));
$('#save').addEventListener('click', async () => {
  const c = collect();
  if (!/^https:\/\/[^/]+$/.test(c.crm)) return msg('כתובת ה-CRM צריכה להיות בפורמט https://crm.example.co.il', false);
  if (c.key && !/^tk_[a-f0-9]{48}$/.test(c.key)) return msg('המפתח לא תקין. העתק אותו שוב מה-CRM.', false);
  if (!(await ensurePerms(c))) return msg('בלי ההרשאה לאתרים התוסף לא יוכל לעבוד.', false);
  await chrome.storage.local.set(c); msg('נשמר.', true);
});
$('#test').addEventListener('click', async () => {
  const c = collect();
  try { const r = await fetch(c.crm + '/api/ext/ping', { headers: { Authorization: 'Bearer ' + c.key } }); const j = await r.json().catch(() => ({}));
    if (r.ok) msg('מחובר ל-CRM (מפתח: ' + (j.label || '') + ').', true); else msg(j.message || ('שגיאה ' + r.status), false); }
  catch (e) { msg('אין חיבור לכתובת הזו: ' + e.message, false); }
});
load();
