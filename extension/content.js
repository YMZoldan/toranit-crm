(() => {
  /* search request from the CRM: #toranit-q=<text>  ->  fill the site's search box and submit */
  (function autoSearch() {
    const m = /[#&]toranit-q=([^&]*)/.exec(location.hash || ''); if (!m) return;
    let q = ''; try { q = decodeURIComponent(m[1]); } catch (e) { q = m[1]; }
    history.replaceState(null, '', location.pathname + location.search);
    if (!q.trim()) return;
    const visible = el => { const r = el.getBoundingClientRect(), st = getComputedStyle(el); return st.display !== 'none' && st.visibility !== 'hidden' && (r.width > 0 || r.height > 0); };
    const find = () => {
      const sel = ['input[type="search"]', 'input[name="s"]', 'input[name="q"]', 'input[name*="search" i]', 'input[id*="search" i]', 'input[class*="search" i]', 'input[placeholder*="חיפוש"]', 'input[placeholder*="חפש"]', 'input[placeholder*="search" i]', 'input[aria-label*="חיפוש"]', 'input[aria-label*="search" i]'];
      const all = sel.flatMap(s => [...document.querySelectorAll(s)]).filter(el => !el.disabled && el.type !== 'hidden');
      return all.find(visible) || all[0] || null;
    };
    let tries = 0;
    const attempt = () => {
      const inp = find();
      if (!inp) { if (++tries < 20) return setTimeout(attempt, 300); return; }
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      inp.focus(); setter.call(inp, q);
      inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true }));
      ['keyup'].forEach(t => inp.dispatchEvent(new KeyboardEvent(t, { key: 'a', bubbles: true })));
      setTimeout(() => {
        // 1. a search button right next to the box (icon / button), the most reliable on custom sites
        const BTN = 'button[type="submit"], button[class*="search" i], [class*="search" i] button, [class*="b_" i][class*="search" i], span[class*="search" i][title], [title*="search" i], [title*="חיפוש"], [aria-label*="search" i], [aria-label*="חיפוש"], a[class*="search" i], i[class*="search" i]';
        let box = inp.parentElement, btn = null;
        for (let k = 0; k < 3 && box && !btn; k++, box = box.parentElement) btn = [...box.querySelectorAll(BTN)].find(el => el !== inp && !el.contains(inp) && !/^(input|textarea)$/i.test(el.tagName)) || null;
        if (btn) { (btn.closest('button, a, span, div[role="button"]') || btn).click(); return; }
        // 2. a small, dedicated search form (not a page-wide form like ASP.NET's form_main)
        const form = inp.form;
        const small = form && form.querySelectorAll('input:not([type="hidden"]), select, textarea').length <= 3 && !form.querySelector('[name="__VIEWSTATE"]') && inp.name;
        if (small) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); return; }
        // 3. Enter key, for sites that listen to the keyboard
        ['keydown', 'keypress', 'keyup'].forEach(t => inp.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: t === 'keypress' ? 13 : 0, bubbles: true, cancelable: true })));
      }, 250);
    };
    if (document.readyState === 'complete') attempt(); else window.addEventListener('load', attempt);
  })();
  if (window.__toranitBtn) return; window.__toranitBtn = true;
  const txt = el => (el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim();
  const num = s => { let t = String(s || '').replace(/[^\d.,]/g, ''); if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.'); else t = t.replace(/,/g, ''); const v = parseFloat(t); return isFinite(v) && v > 0 ? v : null; };
  const meta = p => { const m = document.querySelector('meta[property="' + p + '"],meta[name="' + p + '"],meta[itemprop="' + p + '"]'); return m ? m.getAttribute('content') || '' : ''; };
  const MPN_RE = /(?:מק["״׳']?ט\s*יצרן|part\s*number|p\/n|mpn)\s*[:：]?\s*([A-Z0-9][A-Z0-9#\/._-]{2,40})/i;
  const priceIn = el => {
    if (!el) return null;
    const ins = el.querySelector && el.querySelector('ins'); if (ins) { const v = num(txt(ins)); if (v) return v; }
    const attr = el.getAttribute && (el.getAttribute('content') || el.getAttribute('data-price')); if (attr && num(attr)) return num(attr);
    const m = txt(el).match(/[\d,.]+/g); if (!m) return null; const vals = m.map(num).filter(Boolean); return vals.length ? vals[vals.length - 1] : null;
  };

  /* a single product page */
  function extractPage() {
    const r = { name: '', mpn: '', sku: '', price: null, brand: '', image: '', stock: '', specs: [], url: location.href };
    document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
      try { const walk = o => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(walk); if (o['@graph']) walk(o['@graph']);
        if (/product/i.test(String(o['@type'] || ''))) { r.name = r.name || o.name || ''; r.mpn = r.mpn || o.mpn || ''; r.sku = r.sku || o.sku || ''; r.brand = r.brand || (o.brand && (o.brand.name || o.brand)) || '';
          const img = Array.isArray(o.image) ? o.image[0] : o.image; r.image = r.image || (img && (img.url || img)) || '';
          const of = Array.isArray(o.offers) ? o.offers[0] : o.offers; if (of && r.price == null) r.price = num(of.price || of.lowPrice || (of.priceSpecification && of.priceSpecification.price)); } };
        walk(JSON.parse(s.textContent)); } catch (e) {}
    });
    const ogT = meta('og:title'), ogI = meta('og:image');
    r.name = r.name || txt(document.querySelector('h1.product_title, h1.product-title, .product-name h1, .product-details h1, h1')) || ogT;
    r.image = r.image || (ogI && !/\/images\/?$/.test(ogI) ? ogI : '') || ((document.querySelector('.woocommerce-product-gallery img, .product-image img, img.wp-post-image, .thumb-main-pic, .product-gallery img, .main-image img') || {}).src || '');
    if (r.price == null) r.price = num(meta('product:price:amount'));
    if (r.price == null) r.price = priceIn(document.querySelector('.summary .price, .product-info .price, .product-details .price, [itemprop="price"], .price'));
    if (r.price == null) { const m = /₪\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*₪/.exec(txt(document.querySelector('main') || document.body)); if (m) r.price = num(m[1] || m[2]); }
    r.sku = r.sku || txt(document.querySelector('.summary .sku, .product_meta .sku'));
    const sk = document.querySelector('.man-sku .sku-copy, [data-sku]'); if (sk && !r.mpn) r.mpn = sk.getAttribute('data-sku') || txt(sk);
    const body = txt(document.querySelector('.summary, .product, .product-details, main') || document.body);
    const mm = MPN_RE.exec(body); if (mm && !r.mpn) r.mpn = mm[1];
    document.querySelectorAll('table.woocommerce-product-attributes tr, table.shop_attributes tr, .product-attributes tr, .specs tr, table tr').forEach(tr => {
      const k = txt(tr.querySelector('th, td:first-child')), v = txt(tr.querySelector('td:last-child')); if (!k || !v || k === v || k.length > 40 || r.specs.length >= 16) return;
      if (/מק["״׳']?ט\s*יצרן|part\s*number|mpn/i.test(k)) { if (!r.mpn) r.mpn = v.split(/\s/)[0]; }
      else if (/יצרן|brand|מותג/i.test(k) && !r.brand) r.brand = v;
      else r.specs.push([k, v.slice(0, 160)]);
    });
    const st = document.querySelector('.stockMsg, .stock, .availability, [class*="stock"]'); r.stock = st ? txt(st).slice(0, 40) : '';
    const sel = String(window.getSelection() || '').trim(); if (sel && sel.length < 200 && !r.name) r.name = sel;
    return clean(r);
  }

  /* one product card in a list / search results */
  const CARD_SEL = '.product-thumb, li.product, .product-item, .product-card, .product-box, .productBox, .item-product, .product-grid-item, .products .product, [class*="product-wrap"] > [class*="col"]';
  function extractCard(card) {
    const r = { name: '', mpn: '', sku: '', price: null, brand: '', image: '', stock: '', specs: [], url: '' };
    r.name = txt(card.querySelector('h5.title, .woocommerce-loop-product__title, .product-title, .product-name, .name, .title, h2, h3, h4, h5')) || (card.querySelector('img') || {}).alt || '';
    const sk = card.querySelector('.man-sku .sku-copy, [data-sku], .sku'); if (sk) r.mpn = sk.getAttribute('data-sku') || txt(sk);
    if (!r.mpn) { const m = MPN_RE.exec(txt(card)); if (m) r.mpn = m[1]; }
    r.price = priceIn(card.querySelector('.price, [class*="price" i]'));
    if (r.price == null) { const m = /₪\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*₪/.exec(txt(card)); if (m) r.price = num(m[1] || m[2]); }
    const st = card.querySelector('.stockMsg, .stock, [class*="stock" i], .availability'); r.stock = st ? txt(st).slice(0, 40) : '';
    const img = card.querySelector('img.thumb-main-pic, img.wp-post-image, img'); r.image = img ? (img.currentSrc || img.src || img.getAttribute('data-src') || '') : '';
    const a = card.querySelector('a[href*="/product"], a[href*="product="], a.thumb, a[href]'); r.url = a ? a.href : location.href;
    return clean(r);
  }
  function clean(r) {
    r.name = String(r.name || '').slice(0, 200); r.mpn = String(r.mpn || '').replace(/\s+/g, '').slice(0, 40); r.sku = String(r.sku || '').slice(0, 60);
    if (r.image && !/^https:\/\//i.test(r.image)) r.image = '';
    return r;
  }

  /* UI: floating button for product pages, small buttons on cards, and the review panel */
  const host = document.createElement('div'); host.style.cssText = 'position:fixed;bottom:18px;left:18px;z-index:2147483647'; document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = '<style>*{box-sizing:border-box;font-family:system-ui,Segoe UI,Arial,sans-serif}button{font:inherit;cursor:pointer}' +
    '.fab{background:#272336;color:#fff;border:0;border-radius:24px;padding:10px 16px;font-weight:700;box-shadow:0 4px 14px rgba(0,0,0,.25);display:flex;gap:8px;align-items:center}.fab i{color:#eb5a44;font-style:normal}' +
    '.pn{direction:rtl;width:340px;background:#fff;color:#272336;border:1px solid #dddbe3;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.25);padding:14px;margin-bottom:8px;font-size:14px}' +
    '.pn h3{margin:0 0 8px;font-size:16px}.pn label{display:block;margin:7px 0 2px;font-size:12.5px;color:#6b6878}.pn input,.pn select{width:100%;padding:7px;border:1px solid #dddbe3;border-radius:7px;font:inherit}' +
    '.row{display:flex;gap:8px}.row>*{flex:1}.img{display:flex;gap:10px;align-items:center;margin-bottom:6px}.img img{width:60px;height:60px;object-fit:contain;border:1px solid #eee;border-radius:6px}' +
    '.go{background:#d2452e;color:#fff;border:0;border-radius:8px;padding:9px 14px;font-weight:700}.x{background:#fff;border:1px solid #dddbe3;border-radius:8px;padding:9px 12px}.bt{display:flex;gap:8px;margin-top:12px}.msg{margin-top:8px;font-weight:600}.ok{color:#067647}.bad{color:#b42318}.chk{display:flex;gap:6px;align-items:center;color:#272336;font-size:13px}.chk input{width:auto}</style>' +
    '<div id="pn"></div><button class="fab" id="fab"><i>+</i> הוסף ל־Toranit</button>';
  const pn = root.getElementById('pn'), fab = root.getElementById('fab');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  async function openPanel(x) {
    const cfg = await chrome.runtime.sendMessage({ type: 'cfg' });
    if (!cfg || !cfg.key) { pn.innerHTML = '<div class="pn"><h3>Toranit</h3><div class="msg bad">לא הוגדר מפתח. פתח את הגדרות התוסף.</div></div>'; return; }
    const sup = cfg.supplier || '', vatIncl = !!(cfg.vatIncl || {})[sup];
    pn.innerHTML = '<div class="pn"><h3>הוספה ל־Toranit · ' + esc(sup) + '</h3>' + (x.image ? '<div class="img"><img src="' + esc(x.image) + '"><span style="color:#6b6878;font-size:12.5px">התמונה תישמר בקטלוג</span></div>' : '') +
      '<label>שם המוצר</label><input id="n" value="' + esc(x.name) + '">' +
      '<div class="row"><div><label>מק״ט יצרן</label><input id="mp" dir="ltr" value="' + esc(x.mpn) + '"></div><div><label>מק״ט ספק</label><input id="sk" dir="ltr" value="' + esc(x.sku) + '"></div></div>' +
      '<div class="row"><div><label>מחיר (₪)</label><input id="p" type="number" step="any" value="' + (x.price == null ? '' : x.price) + '"></div><div><label>מלאי</label><input id="st" value="' + esc(x.stock) + '"></div></div>' +
      '<label class="chk"><input type="checkbox" id="vat"' + (vatIncl ? ' checked' : '') + '> המחיר באתר כולל מע״מ</label>' +
      '<div class="row"><div><label>להוסיף ל</label><select id="dl"><option value="">קטלוג בלבד</option></select></div><div style="flex:.45"><label>כמות</label><input id="q" type="number" min="1" value="1"></div></div>' +
      '<div class="bt"><button class="go" id="go">שלח</button><button class="x" id="cl">סגור</button></div><div class="msg" id="m"></div></div>';
    const $ = id => root.getElementById(id), say = (t, ok) => { $('m').textContent = t; $('m').className = 'msg ' + (ok ? 'ok' : 'bad'); };
    $('cl').addEventListener('click', () => { pn.innerHTML = ''; });
    chrome.runtime.sendMessage({ type: 'deals' }).then(r => { if (r && r.ok) { r.deals.forEach(d => { const o = document.createElement('option'); o.value = d.id; o.textContent = 'הזמנה #' + d.number + (d.customer ? ' · ' + d.customer : '') + (d.title ? ' · ' + d.title : ''); $('dl').appendChild(o); }); if (r.last && [...$('dl').options].some(o => o.value === r.last)) $('dl').value = r.last; } });
    $('go').addEventListener('click', async () => {
      const price = parseFloat($('p').value), vat = $('vat').checked;
      if (!$('n').value.trim()) return say('חסר שם מוצר');
      if (!(price > 0)) return say('חסר מחיר. העתק אותו מהדף.');
      $('go').disabled = true; say('שולח...', true);
      const r = await chrome.runtime.sendMessage({ type: 'product', vat, body: { supplier: sup, name: $('n').value.trim(), mpn: $('mp').value.trim(), sku: $('sk').value.trim(), price: vat ? price / (1 + (cfg.vatRate || 18) / 100) : price,
        stock: $('st').value.trim(), image: x.image, brand: x.brand, specs: x.specs, url: x.url || location.href, dealId: $('dl').value || null, qty: +$('q').value || 1 } });
      $('go').disabled = false;
      if (r && r.ok) say((r.res.added ? 'נוסף לקטלוג' : 'עודכן בקטלוג') + (r.res.deal ? ' ולהזמנה #' + r.res.deal.number : '') + '.', true); else say((r && r.error) || 'השליחה נכשלה');
    });
  }
  fab.addEventListener('click', () => { if (pn.innerHTML) { pn.innerHTML = ''; return; } openPanel(extractPage()); });

  /* small "+ Toranit" button on every product card (also cards loaded later) */
  function decorate() {
    const cards = [...document.querySelectorAll(CARD_SEL)].filter(c => !c.dataset.toranit && c.querySelector('img') && /[\d]/.test(txt(c.querySelector('.price, [class*="price" i]')) || (/₪/.test(txt(c)) ? '1' : '')));
    cards.forEach(c => {
      if (c.parentElement && c.parentElement.closest('[data-toranit]')) return;
      c.dataset.toranit = '1';
      if (getComputedStyle(c).position === 'static') c.style.position = 'relative';
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = '+ Toranit'; b.title = 'הוסף ל־Toranit';
      b.style.cssText = 'position:absolute;top:6px;left:6px;z-index:20;background:#272336;color:#fff;border:0;border-radius:14px;padding:4px 9px;font:700 12px system-ui,Arial,sans-serif;cursor:pointer;opacity:.92;box-shadow:0 2px 6px rgba(0,0,0,.25)';
      b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openPanel(extractCard(c)); });
      c.appendChild(b);
    });
    fab.style.display = cards.length || document.querySelector('[data-toranit]') ? (document.querySelector('h1.product_title, .product-details h1, script[type="application/ld+json"]') ? '' : 'none') : '';
  }
  let tmr = null;
  new MutationObserver(() => { clearTimeout(tmr); tmr = setTimeout(decorate, 400); }).observe(document.documentElement, { childList: true, subtree: true });
  decorate();
})();
