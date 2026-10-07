const DEFAULTS = {
  crm: 'https://crm.toranit.co.il', key: '', enabled: true,
  suppliers: [{ domain: 'b-tech.co.il', name: 'ביטק' }, { domain: 'morlevi.co.il', name: 'מורלוי' }, { domain: 'grandadvance.co.il', name: 'גרנד אדוונס' }],
  log: []
};
async function getCfg() { const s = await chrome.storage.local.get(null); return Object.assign({}, DEFAULTS, s); }
const hostOf = u => { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } };
const crmBase = cfg => String(cfg.crm || '').trim().replace(/\/+$/, '');
