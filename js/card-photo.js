// Card photos in Edit Card (cp*). See CLAUDE.md "Card photos". Loaded after js/quick-bar.js.
// - Any card: take or choose a photo of that card. Saved like Show Mode photos (IndexedDB, uploaded by
//   the outbox, then linked as inventory.primary_capture_id), so it works offline.
// - Raw single cards only: instead of a photo, pick a CardSight catalog image as the representative
//   image (inventory.stock_image_id). Never offered for graded cards: their photo must be the exact
//   slab, because buyers match the cert number. Never offered for lots or sealed product.
// The marketplace listing rule (publish_listings) uses the same definitions; see mkImageOk().

let _cpCard = null;          // card open in Edit Card
let _cpSearchSeq = 0;
let _cpBusy = false;

function _cpEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// A grading company named in a card title: "PSA" etc. in capitals, or a grader followed by a grade
// in any case ("psa 10", "bgs 9.5"). Same rule as _listing_image_state() in the listing migration.
const CP_TITLE_GRADER_RE = /\b(PSA|BGS|BVG|SGC|CGC|TAG|HGA|GMA|CSG|AGS|ISA)\b/;
const CP_TITLE_GRADE_RE = /\b(psa|bgs|bvg|sgc|cgc|tag|hga|gma|csg)\s?(10|[1-9](\.5)?)\b/i;
function cpTitleGrader(title) {
  const t = String(title || '');
  const m = t.match(CP_TITLE_GRADER_RE) || t.match(CP_TITLE_GRADE_RE);
  return m ? m[1].toUpperCase() : '';
}

// Graded = a grader other than Raw, a cert number, or a grader named in the title.
// form: read Edit Card's live fields.
function cpIsGraded(card, form) {
  let grader, cert, title;
  if (form && document.getElementById('cem_grader')) {
    grader = typeof _resolveGraderValue === 'function' ? _resolveGraderValue('cem_grader', 'cem_grader_other') : document.getElementById('cem_grader').value;
    cert = document.getElementById('cem_cert')?.value;
    title = document.getElementById('cem_title')?.value;
  } else {
    grader = card && card.Grader; cert = card && card['Cert #']; title = card && card['Card Title'];
  }
  grader = String(grader || '').trim();
  return (!!grader && grader.toLowerCase() !== 'raw') || !!String(cert || '').trim() || !!cpTitleGrader(title);
}
// Graded only because the title names a grader (the Grader field is empty).
function cpGraderOnlyInTitle(card, form) {
  const field = form && document.getElementById('cem_grader')
    ? (typeof _resolveGraderValue === 'function' ? _resolveGraderValue('cem_grader', 'cem_grader_other') : document.getElementById('cem_grader').value)
    : card && card.Grader;
  const cert = form ? document.getElementById('cem_cert')?.value : card && card['Cert #'];
  const title = form ? document.getElementById('cem_title')?.value : card && card['Card Title'];
  const f = String(field || '').trim();
  return (!f || f.toLowerCase() === 'raw') && !String(cert || '').trim() ? cpTitleGrader(title) : '';
}
function cpItemType(card) { return (card && card.item_type) || 'card'; }

// The capture id of the seller's own photo of this card, or null.
function cpSellerPhotoId(card) {
  if (!card) return null;
  let local = null;
  try { local = card._dbId && typeof _smCaptureIndex !== 'undefined' ? _smCaptureIndex.get(card._dbId) : null; } catch (_) {}
  return card._captureId || local || card._primaryCaptureId || null;
}
function cpSellerPhotoUrl(card) {
  const id = cpSellerPhotoId(card);
  try { return id && typeof _smThumbUrls !== 'undefined' ? (_smThumbUrls.get(id) || null) : null; } catch (_) { return null; }
}
function cpStockUrl(card) {
  const id = card && card.StockImageId;
  if (!id) return null;
  return typeof smStockImageUrl === 'function' ? smStockImageUrl(id) : '/.netlify/functions/card-image?id=' + encodeURIComponent(id);
}
// Catalog images are offered for raw single cards only.
function cpCanUseCatalog(card, form) { return cpItemType(card) === 'card' && !cpIsGraded(card, form); }

// ── Edit Card block (#cem_photo_box) ──
function cpCemFill(card) {
  _cpCard = card || null;
  const box = document.getElementById('cem_photo_box');
  if (!box) return;
  const on = !!card && currentRole === 'seller';
  box.style.display = on ? '' : 'none';
  document.getElementById('cem_photo_options').innerHTML = '';
  if (!on) return;
  cpCemRender();
  // A photo saved on another device needs a signed URL first.
  if (cpSellerPhotoId(card) && !cpSellerPhotoUrl(card) && typeof _smLoadRemoteThumbs === 'function') {
    _smLoadRemoteThumbs().then(changed => { if (changed && _cpCard === card) cpCemRender(); }).catch(() => {});
  }
}

function cpCemRender() {
  const card = _cpCard;
  if (!card) return;
  const thumb = document.getElementById('cem_photo_thumb');
  const status = document.getElementById('cem_photo_status');
  const take = document.getElementById('cem_photo_take');
  const stockBtn = document.getElementById('cem_photo_stock');
  const removeBtn = document.getElementById('cem_photo_stock_remove');
  const graded = cpIsGraded(card, true);
  const sealed = cpItemType(card) === 'sealed';
  const hasOwn = !!cpSellerPhotoId(card);
  const ownUrl = cpSellerPhotoUrl(card);
  const stockOk = !!card.StockImageId && cpCanUseCatalog(card, true);
  const url = hasOwn ? ownUrl : (stockOk ? cpStockUrl(card) : null);

  thumb.innerHTML = url
    ? `<img src="${_cpEsc(url)}" alt="" onerror="this.remove()">${!hasOwn ? '<span class="cp-tag">Catalog</span>' : ''}`
    : (hasOwn ? '<span class="cp-empty">Photo saved</span>' : '<span class="cp-empty">No photo</span>');
  thumb.classList.toggle('cp-thumb--stock', !hasOwn && stockOk);

  let msg;
  if (hasOwn) msg = 'Your photo of this card.';
  else if (stockOk) msg = 'Catalog image (not your card). Buyers see it as a representative image. A photo of your own card is better.';
  else if (graded) {
    const fromTitle = cpGraderOnlyInTitle(card, true);
    msg = (fromTitle ? `The title says ${fromTitle}, so this looks like a graded card. Set the Grader field if it is. ` : '')
      + 'Graded cards need a photo of the exact slab, so buyers can match the cert number.'
      + (card.StockImageId ? ' The catalog image you picked isn\'t used for graded cards.' : '');
  }
  else if (sealed) msg = 'Optional. Sealed product can be listed without a photo.';
  else if (cpItemType(card) === 'lot') msg = 'Add a photo of the lot.';
  else msg = 'No photo yet. Take one, or pick a catalog image of this card.';
  status.textContent = msg;

  take.textContent = hasOwn ? '📷 Replace photo' : (graded ? '📷 Photo of the slab' : '📷 Take or choose a photo');
  take.disabled = _cpBusy;
  const canCatalog = !hasOwn && cpCanUseCatalog(card, true);
  stockBtn.style.display = canCatalog ? '' : 'none';
  stockBtn.textContent = stockOk ? 'Change catalog image' : 'Use a catalog image';
  removeBtn.style.display = !hasOwn && card.StockImageId ? '' : 'none';
  if (!canCatalog) document.getElementById('cem_photo_options').innerHTML = '';
}

// Grader / cert edits change what's allowed.
function cpCemFormChanged() { if (_cpCard) cpCemRender(); }

function cpTakePhoto() { if (!_cpBusy) document.getElementById('cem_photo_input').click(); }

async function cpPhotoPicked(input) {
  const file = input.files && input.files[0];
  input.value = '';
  const card = _cpCard;
  if (!file || !card) return;
  if (!card._dbId) { showToast('Save the card first, then add a photo', '#f59e0b'); return; }
  if (typeof smSaveCapture !== 'function' || typeof smEnqueue !== 'function') {
    showToast('Photos can\'t be saved on this device', '#ef4444'); return;
  }
  const replacing = !!cpSellerPhotoId(card);
  _cpBusy = true;
  const take = document.getElementById('cem_photo_take');
  if (take) { take.disabled = true; take.textContent = 'Saving photo…'; }
  try {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (_) { bmp = await createImageBitmap(file); }
    const crop = await _smCanvasBlob(_smDrawScaled(bmp, 0, 0, bmp.width, bmp.height, 1400));
    if (bmp.close) bmp.close();
    const cap = await smSaveCapture({ crop, original: null, entryPoint: 'case_scan' });
    await smUpdateCapture(cap.id, { attachedTo: card._dbId });
    smThumbUrl(cap.id, crop);
    _smCaptureIndex.set(card._dbId, cap.id);
    card._captureId = cap.id;
    await smEnqueue({ type: 'attach_capture', captureId: cap.id, inventoryId: card._dbId, replace: replacing });
    showToast(replacing ? 'Photo replaced' : 'Photo added');
  } catch (e) {
    console.warn('[card-photo] photo not saved', e);
    showToast('Couldn\'t save the photo — try again', '#ef4444');
  } finally {
    _cpBusy = false;
    if (_cpCard === card) { cpCemRender(); _cpRefreshMarketplace(card); }
    if (typeof applyInventoryFilters === 'function') applyInventoryFilters();
  }
}

// Keep Edit Card's Marketplace section in step (its status depends on the photo), without closing it.
function _cpRefreshMarketplace(card) {
  if (typeof mkCemFill !== 'function') return;
  const box = document.getElementById('cem_mk_details');
  const wasOpen = !!(box && box.open);
  mkCemFill(card);
  if (box && wasOpen) box.open = true;
}

// ── Catalog images (raw cards) ──
async function cpFindCatalog() {
  const card = _cpCard;
  const box = document.getElementById('cem_photo_options');
  if (!card || !box) return;
  if (!cpCanUseCatalog(card, true)) { box.innerHTML = ''; return; }
  const v = id => (document.getElementById(id)?.value || '').trim();
  const features = typeof _getCheckedFeatures === 'function' ? _getCheckedFeatures('cem_features_group') : (card.Features || []);
  const q = { player: v('cem_player') || card.Player || '', year: v('cem_year') || card.Year || '',
              cardSet: v('cem_set') || card['Set '] || '', cardNumber: v('cem_number') || card.Number || '',
              parallel: v('cem_parallel') || card['Parallel/Variant'] || '',
              title: v('cem_title') || card['Card Title'] || '', features,
              printRun: v('cem_print_run') || card['Print Run'] || '' };
  if (!q.player) { box.innerHTML = '<div class="cp-note">Add the player or character name first.</div>'; return; }
  if (navigator.onLine === false) { box.innerHTML = '<div class="cp-note">Finding catalog images needs a signal.</div>'; return; }
  const seq = ++_cpSearchSeq;
  box.innerHTML = '<div class="cp-note">Looking up catalog images…</div>';
  let results = [], others = [];
  try {
    const res = await fetch('/.netlify/functions/catalog-image-search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
    const data = await res.json();
    if (data && data.success) { results = data.results || []; others = data.others || []; }
  } catch (e) { console.warn('[card-photo] catalog search failed', e); }
  if (seq !== _cpSearchSeq || _cpCard !== card) return;
  const sub = r => r.parallel ? `<em>Base image · your parallel: ${_cpEsc(r.parallel)}</em>`
    : (r.variation ? '<em>Image variation</em>' : '');
  const tile = r => `
      <button type="button" class="cp-opt${r.id === card.StockImageId ? ' cp-opt--on' : ''}" onclick="cpChooseStock('${_cpEsc(r.id)}')" title="${_cpEsc(r.title)}" data-title="${_cpEsc(r.title)}">
        <img src="${_cpEsc(r.imageUrl)}" alt="" loading="lazy" onerror="cpOptionFailed(this)">
        <span>${_cpEsc(r.title)}</span>${sub(r)}
      </button>`;
  // CardSight only has images of the base card. Say so when the card is a parallel or numbered.
  const isParallel = !!(q.parallel || q.printRun || /\/\s*\d+/.test(q.title));
  const parNote = isParallel && results.length
    ? ' Catalog images show the base version, so a color or numbered parallel looks different from your card.' : '';
  const head = results.length
    ? `<div class="cp-note">Catalog images, not your card. Pick the one that matches exactly: same year, set and number.${parNote}</div>
       <div class="cp-grid cp-grid--match" id="cem_photo_grid">${results.map(tile).join('')}</div>`
    : `<div class="cp-note" id="cem_photo_nomatch">No exact catalog match for this card. Take a photo instead${others.length ? ', or check the card details if one of the cards below is it' : ''}.</div>`;
  const rest = others.length ? `
    <details class="cp-others" id="cem_photo_others">
      <summary>Other ${_cpEsc(q.player)} cards${q.year ? ' from ' + _cpEsc(String(q.year).slice(0, 4)) : ''} (${others.length}) · not an exact match</summary>
      <div class="cp-note">These don't match the details above. Only pick one if your card's details are wrong.</div>
      <div class="cp-grid">${others.map(tile).join('')}</div>
    </details>` : '';
  box.innerHTML = head + rest + `
    <button type="button" class="mk-link cp-none" onclick="document.getElementById('cem_photo_options').innerHTML=''">${results.length ? 'None of these match' : 'Close'}</button>`;
}
function cpOptionFailed(img) {
  const opt = img.closest('.cp-opt');
  const grid = opt && opt.parentElement;
  if (opt) opt.remove();
  if (grid && !grid.children.length) {
    if (grid.id === 'cem_photo_grid') {
      const note = grid.previousElementSibling;
      const name = opt && opt.dataset.title;
      if (note) { note.id = 'cem_photo_nomatch'; note.textContent = name
        ? `The catalog has this card (${name}) but no image of it. Take a photo instead.`
        : 'No catalog image for this card. Take a photo instead.'; }
      grid.remove();
    } else {
      const det = grid.closest('details');
      if (det) det.remove();
    }
  }
}

async function cpChooseStock(catalogId) { return _cpSetStock(catalogId); }
async function cpRemoveStock() { return _cpSetStock(null); }

async function _cpSetStock(catalogId) {
  const card = _cpCard;
  if (!card || _cpBusy) return;
  if (catalogId && !cpCanUseCatalog(card, true)) { showToast('Graded cards need a photo of the slab', '#f59e0b'); return; }
  if (!card._dbId || typeof db === 'undefined') { showToast('Save the card first', '#f59e0b'); return; }
  if (navigator.onLine === false) { showToast('Needs a signal. Try again when you\'re online.', '#f59e0b'); return; }
  _cpBusy = true;
  const patch = { stock_image_id: catalogId };
  if (catalogId) patch.catalog_card_id = catalogId;   // the seller confirmed which catalog card this is
  try {
    const { error } = await db.from('inventory').update(patch).eq('id', card._dbId);
    if (error) {
      const missing = /stock_image_id|schema cache|PGRST204/i.test(error.message || '');
      showToast(missing ? 'Catalog images aren\'t set up on the server yet' : 'Couldn\'t save: ' + error.message, '#ef4444');
      return;
    }
    card.StockImageId = catalogId;
    if (catalogId) card.CatalogCardId = catalogId;
    document.getElementById('cem_photo_options').innerHTML = '';
    showToast(catalogId ? 'Catalog image chosen' : 'Catalog image removed');
  } finally {
    _cpBusy = false;
    if (_cpCard === card) { cpCemRender(); _cpRefreshMarketplace(card); }
  }
}
