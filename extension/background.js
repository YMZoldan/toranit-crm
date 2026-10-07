importScripts('common.js');
const OK_EXT = /\.(xlsx|xlsm|xlsb|xls|ods|csv|tsv|pdf|docx|txt)$/i;
function supplierFor(cfg, urls) {
  return (cfg.suppliers || []).find(s => { const d = String(s.domain || '').toLowerCase().replace(/^www\./, ''); return d && urls.some(u => { const h = hostOf(u); return h === d || h.endsWith('.' + d); }); });
}
async function addLog(entry) {
  const { log = [] } = await chrome.storage.local.get('log');
  log.unshift(Object.assign({ at: Date.now() }, entry)); await chrome.storage.local.set({ log: log.slice(0, 25) });
}
function notify(title, message) {
  try { chrome.notifications.create({ type: 'basic', iconUrl: 'icon128.png', title, message: String(message || '').slice(0, 250) }); } catch (e) {}
}
async function sendToCrm(cfg, sup, url, name) {
  let blob;
  if (!/^https?:/i.test(url)) throw new Error('הספק יוצר את הקובץ בתוך הדף, ולכן אי אפשר לשלוח אותו אוטומטית. גרור את הקובץ למסך "מחירוני ספקים" ב-CRM.');
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error('ההורדה מהספק נכשלה (' + r.status + '). ייתכן שהחיבור לפורטל פג.');
  blob = await r.blob();
  const res = await fetch(crmBase(cfg) + '/api/inbox', { method: 'POST', body: blob, headers: {
    'Authorization': 'Bearer ' + cfg.key, 'Content-Type': 'application/octet-stream',
    'X-Supplier': encodeURIComponent(sup.name), 'X-Filename': encodeURIComponent(name), 'X-Source-Url': encodeURIComponent(url.slice(0, 300)) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.message || ('ה-CRM החזיר שגיאה ' + res.status));
}
chrome.downloads.onChanged.addListener(async delta => {
  if (!delta.state || delta.state.current !== 'complete') return;
  const [item] = await chrome.downloads.search({ id: delta.id });
  if (!item) return;
  const cfg = await getCfg();
  if (!cfg.enabled) return;
  const sup = supplierFor(cfg, [item.url, item.finalUrl, item.referrer].filter(Boolean));
  if (!sup) return;
  const name = String(item.filename || '').split(/[\\/]/).pop();
  if (!OK_EXT.test(name)) return;
  if (!cfg.key) { notify('המחירון לא נשלח', 'לא הוגדר מפתח תוסף. פתח את הגדרות התוסף.'); return; }
  try { await sendToCrm(cfg, sup, item.finalUrl || item.url, name); await addLog({ ok: true, supplier: sup.name, file: name }); notify('המחירון של ' + sup.name + ' נשלח ל-CRM', name); }
  catch (e) { await addLog({ ok: false, supplier: sup.name, file: name, error: e.message }); notify('המחירון של ' + sup.name + ' לא נשלח', e.message); }
});
chrome.runtime.onInstalled.addListener(d => { if (d.reason === 'install') chrome.runtime.openOptionsPage(); registerPages(); });
chrome.runtime.onStartup.addListener(registerPages);
chrome.storage.onChanged.addListener(ch => { if (ch.suppliers) registerPages(); });
async function registerPages() {
  const cfg = await getCfg(), builtin = ['b-tech.co.il', 'morlevi.co.il', 'grandadvance.co.il'];
  const extra = (cfg.suppliers || []).map(s => String(s.domain || '').toLowerCase()).filter(d => d && !builtin.includes(d));
  try { await chrome.scripting.unregisterContentScripts({ ids: ['toranit-extra'] }); } catch (e) {}
  if (!extra.length) return;
  const matches = extra.map(d => 'https://*.' + d + '/*');
  if (!(await chrome.permissions.contains({ origins: matches }))) return;
  try { await chrome.scripting.registerContentScripts([{ id: 'toranit-extra', matches, js: ['content.js'], runAt: 'document_idle' }]); } catch (e) {}
}
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    const cfg = await getCfg();
    if (msg.type === 'cfg') { const sup = supplierFor(cfg, [sender.url || '']); return reply({ key: !!cfg.key, supplier: sup ? sup.name : hostOf(sender.url || ''), vatIncl: cfg.vatIncl || {}, vatRate: cfg.vatRate || 18 }); }
    if (!cfg.key) return reply({ ok: false, error: 'לא הוגדר מפתח' });
    const call = async (path, opt) => { const r = await fetch(crmBase(cfg) + path, Object.assign({ headers: { Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json' } }, opt || {})); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.message || ('שגיאה ' + r.status)); return j; };
    if (msg.type === 'deals') { try { return reply({ ok: true, deals: await call('/api/ext/deals'), last: cfg.lastDeal || '' }); } catch (e) { return reply({ ok: false, error: e.message }); } }
    if (msg.type === 'product') {
      try {
        const res = await call('/api/ext/product', { method: 'POST', body: JSON.stringify(msg.body) });
        const vatIncl = Object.assign({}, cfg.vatIncl || {}); vatIncl[msg.body.supplier] = !!msg.vat;
        await chrome.storage.local.set({ vatIncl, lastDeal: msg.body.dealId || '' });
        await addLog({ ok: true, supplier: msg.body.supplier, file: 'מוצר: ' + msg.body.name.slice(0, 60) });
        return reply({ ok: true, res });
      } catch (e) { return reply({ ok: false, error: e.message }); }
    }
  })();
  return true;
});
