const form = document.getElementById('upload-form');
const statusEl = document.getElementById('upload-status');
const uploadPanel = document.getElementById('upload-panel');
const draftsList = document.getElementById('drafts-list');
const harborBoard = document.getElementById('harbor-board');

const authSection = document.getElementById('auth-section');
const connectGateSection = document.getElementById('connect-gate-section');
const dashboard = document.getElementById('dashboard');
const accountBar = document.getElementById('account-bar');
const ebayStatusBadge = document.getElementById('ebay-status-badge');
const dropzone = document.getElementById('photo-dropzone');
const fileInput = document.getElementById('photo-input');
const previewEl = document.getElementById('photo-preview');

const CONDITION_OPTIONS = [
  ['NEW', 'New'],
  ['NEW_OTHER', 'New (no original packaging)'],
  ['USED_EXCELLENT', 'Used - Excellent'],
  ['USED_VERY_GOOD', 'Used - Very Good'],
  ['USED_GOOD', 'Used - Good'],
  ['USED_ACCEPTABLE', 'Used - Acceptable'],
  ['FOR_PARTS_OR_NOT_WORKING', 'For Parts / Not Working'],
];

// Maps this app's internal draft lifecycle to the voyage language used throughout the UI.
const STAGE_BADGES = {
  draft: ['In Port', 'stage-inport'],
  reviewed: ['Ready to Sail', 'stage-ready'],
  pushed_to_ebay: ['Delayed at Dock', 'stage-delayed'],
  published: ['Delivered', 'stage-delivered'],
};

// Fixed left-to-right order for the harbor board tally, regardless of which stages are
// actually present in this batch of drafts (a stage with zero items still gets a column,
// so the board always reads as the full route rather than reshuffling as things ship).
const STAGE_ORDER = ['draft', 'reviewed', 'pushed_to_ebay', 'published'];

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ============================================================
// Ship marks — a ship idling in the bay (ported from the Bali Bay
// living-logo design: idle bob/drift on a wave, with a brief "impulse"
// acceleration on hover before easing back to rest). Static single frame
// under reduced motion. Used for both the header wordmark and the footer
// mark - each .ship-mark SVG gets its own independent instance.
// ============================================================
function initShipMarks() {
  document.querySelectorAll('.ship-mark').forEach(initShipMark);
}

function initShipMark(svg) {
  const num = (el, key, fallback) => {
    const v = parseFloat(el.dataset[key]);
    return isNaN(v) ? fallback : v;
  };

  const ships = Array.from(svg.querySelectorAll('[data-ship]')).map((el, i) => {
    const wake = el.querySelector('[data-wake]');
    return {
      hull: el.querySelector('[data-hull]'),
      wake,
      ripples: wake ? Array.from(wake.children) : [],
      ampX: num(el, 'ampx', 5),
      ampY: num(el, 'ampy', 1.8),
      rot: num(el, 'rot', 1.7),
      per: num(el, 'per', 8),
      dir: el.dataset.dir === 'left' ? -1 : 1,
      phase: i * 1.73,
      impT: -99,
    };
  });
  const waves = Array.from(svg.querySelectorAll('[data-wave]')).map((el) => ({
    el,
    speed: num(el, 'speed', 5),
    per: num(el, 'per', 60),
    phase: num(el, 'phase', 0),
  }));

  let currentT = 0;
  const lockup = svg.parentElement;
  if (lockup) {
    lockup.addEventListener('pointerenter', () => {
      for (const s of ships) {
        if (currentT - s.impT > 0.9) s.impT = currentT;
      }
    });
  }

  function frame(t) {
    currentT = t;
    const TAU = Math.PI * 2;
    for (const s of ships) {
      const u = (t - s.impT) / 2.0;
      let k = 0;
      if (u >= 0 && u <= 1) k = Math.sin(Math.PI * Math.pow(u, 0.62));
      const bob = Math.sin((t / s.per) * TAU + s.phase) * s.ampY + Math.sin(t * 1.7 + s.phase) * 0.45;
      const drift = Math.sin((t / (s.per * 1.7)) * TAU + s.phase * 0.7) * s.ampX;
      const x = drift + k * s.dir * 15;
      const y = bob - k * 3.0 + Math.sin(Math.PI * u) * (u >= 0 && u <= 1 ? -0.8 : 0);
      const rot = Math.sin((t / s.per) * TAU + s.phase + 0.9) * s.rot - k * s.dir * 2.4;
      if (s.hull) s.hull.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${rot.toFixed(2)})`);
      if (s.wake) s.wake.setAttribute('transform', `translate(${(x * 0.92).toFixed(2)} ${(bob * 0.35).toFixed(2)})`);
      // A rare, brief "idle wake" - a narrow smooth spike (high power on a slow sine) so the
      // ship occasionally leaves a faint trace at rest, instead of a constant idle shimmer.
      const idleBlip = Math.max(0, Math.sin(t / 17 + s.phase * 2)) ** 26;
      const n = s.ripples.length;
      const rate = 0.5 + k * 1.1;
      for (let i = 0; i < n; i++) {
        const ph = (t * rate + i / n) % 1;
        s.ripples[i].setAttribute('transform', `translate(${(-ph * 17 * s.dir).toFixed(2)} ${(ph * 0.8).toFixed(2)})`);
        s.ripples[i].setAttribute('opacity', ((1 - ph) * (0.1 * idleBlip + k * 0.42)).toFixed(3));
      }
    }
    for (const w of waves) {
      const dx = -((t * w.speed) % w.per);
      const dy = Math.sin(t * 0.75 + w.phase) * 0.7;
      w.el.setAttribute('transform', `translate(${dx.toFixed(2)} ${dy.toFixed(2)})`);
    }
  }

  if (prefersReducedMotion()) {
    frame(0);
    return;
  }
  const t0 = performance.now();
  function loop(now) {
    requestAnimationFrame(loop);
    frame((now - t0) / 1000);
  }
  requestAnimationFrame(loop);
}

// --- Drag & drop / file picker for the "New Part" form ---
let selectedFiles = [];

function setupDropzone(zoneEl, inputEl, onFilesAdded) {
  zoneEl.addEventListener('click', () => inputEl.click());
  zoneEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    zoneEl.classList.add('dragover');
  });
  zoneEl.addEventListener('dragleave', () => zoneEl.classList.remove('dragover'));
  zoneEl.addEventListener('drop', (e) => {
    e.preventDefault();
    zoneEl.classList.remove('dragover');
    onFilesAdded(Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/')));
  });
  inputEl.addEventListener('change', () => {
    onFilesAdded(Array.from(inputEl.files).filter((f) => f.type.startsWith('image/')));
    inputEl.value = '';
  });
}

setupDropzone(dropzone, fileInput, (files) => {
  selectedFiles = [...selectedFiles, ...files].slice(0, 12);
  renderSelectedFiles();
});

function renderSelectedFiles() {
  previewEl.innerHTML = '';
  selectedFiles.forEach((file, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.innerHTML = `<img src="${URL.createObjectURL(file)}" alt="" /><button type="button">&times;</button>`;
    thumb.querySelector('button').addEventListener('click', () => {
      selectedFiles.splice(i, 1);
      renderSelectedFiles();
    });
    previewEl.appendChild(thumb);
  });
}

// ============================================================
// Voyage map — shared inline-SVG builder for both loading experiences
// ============================================================
const VOYAGE_PATH_D = 'M40 90 C 120 20, 260 110, 360 40';

function buildVoyageMap({ originLabel, destLabel }) {
  const shipSilhouette = '<g class="voyage-ship" transform="translate(-9,-7)"><path d="M0 10 L18 10 L15 14 L3 14 Z" /></g>';
  return `
    <svg class="voyage-map" viewBox="0 0 400 120" role="img" aria-label="Voyage from ${escapeAttr(originLabel)} to ${escapeAttr(destLabel)}">
      <rect class="voyage-water" x="0" y="0" width="400" height="120" rx="8" />
      <path class="voyage-chart-line" d="M20 20 L20 100 M60 10 L60 110 M340 10 L340 110" stroke-width="1" stroke-dasharray="2 4" />
      <path class="voyage-route" d="${VOYAGE_PATH_D}" />
      <circle class="voyage-waypoint" data-waypoint-frac="0.32" r="2.4" />
      <circle class="voyage-waypoint" data-waypoint-frac="0.58" r="2.4" />
      <circle class="voyage-waypoint" data-waypoint-frac="0.8" r="2.4" />
      <g class="voyage-port">
        <circle cx="40" cy="90" r="6" />
        <text x="40" y="112" text-anchor="middle">${escapeAttr(originLabel)}</text>
      </g>
      <g class="voyage-dest">
        <circle cx="360" cy="40" r="6" />
        <text x="360" y="24" text-anchor="middle">${escapeAttr(destLabel)}</text>
      </g>
      <g class="voyage-ship-ghost-2" style="offset-path: path('${VOYAGE_PATH_D}');">${shipSilhouette}</g>
      <g class="voyage-ship-ghost-1" style="offset-path: path('${VOYAGE_PATH_D}');">${shipSilhouette}</g>
      <g class="voyage-ship-group" style="offset-path: path('${VOYAGE_PATH_D}');">
        <ellipse class="voyage-ship-wake" cx="-13" cy="11" rx="6" ry="1.8" />
        <g class="voyage-ship" transform="translate(-9,-7)">
          <path d="M0 10 L18 10 L15 14 L3 14 Z" />
          <path class="voyage-ship-sail" d="M9 2 L9 10 L2 10 Z" />
        </g>
      </g>
    </svg>
  `;
}

// Measures the route once it's in the DOM, positions waypoint dots exactly on the curve, and
// plays a "charting the route" draw-in reveal (0 -> full length) before handing off to the
// ongoing dash-scroll animation - communicating "the voyage is being plotted" on first appearance
// rather than just showing an already-complete route.
function initVoyageMap(root) {
  const path = root.querySelector('.voyage-route');
  if (!path) return;
  const length = path.getTotalLength();

  root.querySelectorAll('.voyage-waypoint').forEach((dot) => {
    const frac = parseFloat(dot.dataset.waypointFrac) || 0;
    const pt = path.getPointAtLength(frac * length);
    dot.setAttribute('cx', pt.x.toFixed(1));
    dot.setAttribute('cy', pt.y.toFixed(1));
  });

  if (prefersReducedMotion()) {
    path.classList.add('charted');
    return;
  }

  path.style.strokeDasharray = String(length);
  path.style.strokeDashoffset = String(length);
  path.classList.add('drawing');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      path.style.strokeDashoffset = '0';
    });
  });
  path.addEventListener('transitionend', function onDrawEnd() {
    path.removeEventListener('transitionend', onDrawEnd);
    path.classList.remove('drawing');
    path.style.strokeDasharray = '';
    path.style.strokeDashoffset = '';
    path.classList.add('charted');
  }, { once: true });
}

// Builds the stage list once with a stable DOM node per stage, so later updates only toggle
// classes (updateStageList) instead of replacing markup - lets CSS transitions animate the
// active/done state smoothly instead of an abrupt swap.
function buildStageList(stages) {
  return `
    <ul class="voyage-stage-list">
      ${stages.map((label, i) => `<li data-stage-index="${i}">${escapeAttr(label)}</li>`).join('')}
    </ul>
  `;
}
function updateStageList(root, activeIndex) {
  root.querySelectorAll('.voyage-stage-list li').forEach((li, i) => {
    li.classList.toggle('done', i < activeIndex);
    li.classList.toggle('active', i === activeIndex);
  });
}

// Triggers the CSS fade+lift entrance on a dynamically-created element (modal/overlay headings) -
// the element must already carry the .reveal-on-load class in its markup.
function revealNow(el) {
  if (!el) return;
  requestAnimationFrame(() => el.classList.add('revealed'));
}

// Cycles stage text client-side while a single request is in flight - there's no real
// incremental backend progress to reflect for a one-shot API call, so this paces a believable
// progression without ever claiming more than "still working" once stages run out.
function startStageCycle(stages, onUpdate, intervalMs = 2200) {
  let i = 0;
  onUpdate(i);
  const timer = setInterval(() => {
    if (i < stages.length - 1) {
      i += 1;
      onUpdate(i);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

// ============================================================
// AI generation — voyage overlay over the "Prepare Cargo" panel
// ============================================================
const GENERATION_STAGES = ['Charting the voyage', 'Preparing the cargo', 'Writing the listing', 'Finalizing the manifest'];

let activeGenerationController = null;

function showGenerationOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'voyage-overlay';
  overlay.id = 'generation-overlay';
  overlay.innerHTML = `
    <h3 class="reveal-on-load">Charting the voyage&hellip;</h3>
    ${buildVoyageMap({ originLabel: 'Your Store', destLabel: "The AI's Desk" })}
    ${buildStageList(GENERATION_STAGES)}
    <div class="voyage-overlay-actions">
      <button type="button" class="secondary" data-action="cancel-generation">Cancel</button>
    </div>
  `;
  uploadPanel.appendChild(overlay);
  initVoyageMap(overlay);
  revealNow(overlay.querySelector('h3'));

  const stopCycle = startStageCycle(GENERATION_STAGES, (i) => {
    updateStageList(overlay, i);
    statusEl.textContent = `${GENERATION_STAGES[i]}...`;
  });

  overlay.querySelector('[data-action="cancel-generation"]').addEventListener('click', () => {
    if (activeGenerationController) activeGenerationController.abort();
  });

  return { overlay, stopCycle };
}

function removeGenerationOverlay(handle) {
  if (!handle) return;
  handle.stopCycle();
  handle.overlay.remove();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  statusEl.textContent = '';
  statusEl.className = '';

  const formData = new FormData();
  selectedFiles.forEach((file) => formData.append('photos', file));
  formData.append('notes', document.getElementById('notes-input').value);

  activeGenerationController = new AbortController();
  const overlayHandle = showGenerationOverlay();
  form.querySelector('button[type="submit"]').disabled = true;

  try {
    const res = await fetch('/api/parts', { method: 'POST', body: formData, signal: activeGenerationController.signal });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to generate listing');

    removeGenerationOverlay(overlayHandle);
    statusEl.textContent = `Cargo loaded. Confidence: ${data.part.ai_confidence}. ${data.notes_for_seller || ''}`;
    form.reset();
    selectedFiles = [];
    renderSelectedFiles();
    loadDrafts();
  } catch (err) {
    removeGenerationOverlay(overlayHandle);
    if (err.name === 'AbortError') {
      statusEl.textContent = 'Voyage cancelled.';
    } else {
      statusEl.textContent = `Error: ${err.message}`;
      statusEl.className = 'error';
    }
  } finally {
    activeGenerationController = null;
    form.querySelector('button[type="submit"]').disabled = false;
  }
});

// ============================================================
// Harbor board — a tally of the manifest by stage, always showing every
// stage (even at zero) so the board reads as the whole route at a glance.
// ============================================================
function renderHarborBoard(parts) {
  if (parts.length === 0) {
    harborBoard.innerHTML = '';
    return;
  }
  const counts = { draft: 0, reviewed: 0, pushed_to_ebay: 0, published: 0 };
  parts.forEach((p) => { if (p.status in counts) counts[p.status] += 1; });

  harborBoard.innerHTML = `
    <div class="harbor-board">
      ${STAGE_ORDER.map((stage) => {
        const [label] = STAGE_BADGES[stage];
        const count = counts[stage];
        return `
          <div class="harbor-board-item ${count > 0 ? 'has-stage' : ''}">
            <span class="harbor-board-count">${count}</span>
            <span class="harbor-board-label">${escapeAttr(label)}</span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// ============================================================
// Drafts list
// ============================================================
async function loadDrafts() {
  const res = await fetch('/api/parts');
  const parts = await res.json();
  draftsList.innerHTML = '';

  renderHarborBoard(parts);

  if (parts.length === 0) {
    draftsList.innerHTML = '<p class="muted">No cargo in port yet — prepare your first listing above.</p>';
    return;
  }

  const cards = parts.map(renderDraftCard);
  cards.forEach((card) => {
    card.classList.add('entering');
    draftsList.appendChild(card);
  });
  // Fade+lift the whole batch in together (not staggered - the brief explicitly warns against
  // constant/excessive movement) rather than snapping straight to the final rendered state.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      cards.forEach((card) => card.classList.remove('entering'));
    });
  });
}

function renderDraftCard(part) {
  const card = document.createElement('div');
  card.className = 'draft-card';

  const specifics = JSON.parse(part.ai_specifics_json || '{}');
  const photoPaths = JSON.parse(part.photo_paths_json || '[]');
  const isPublished = part.status === 'published';
  const [stageLabel, stageClass] = STAGE_BADGES[part.status] || [part.status, ''];

  const galleryHtml = photoPaths.length > 0
    ? photoPaths.map((p, i) => `
        <div class="thumb">
          <img src="/${p.replace(/^.*uploads/, 'uploads')}" alt="part photo ${i + 1}" loading="lazy" />
          <button type="button" class="remove-photo" data-index="${i}" title="Remove photo">&times;</button>
        </div>
      `).join('')
    : '<div class="placeholder">No photos</div>';

  card.innerHTML = `
    <div class="card-topline">
      <span class="badge ${stageClass}"><strong>${part.ai_confidence || 'unknown'}</strong> confidence &middot; ${stageLabel}</span>
      <button type="button" class="delete-trigger" data-action="delete-trigger" title="Delete draft" aria-haspopup="true" aria-expanded="false">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
          <path d="M2 4h12M6 4V2.5A.5.5 0 0 1 6.5 2h3a.5.5 0 0 1 .5.5V4M6.5 7.5v4M9.5 7.5v4M3.5 4l.6 8.5a1 1 0 0 0 1 .9h5.8a1 1 0 0 0 1-.9L12.5 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <div class="delete-popover" data-role="delete-popover">
        <p>${isPublished || part.status === 'pushed_to_ebay'
          ? `Delete "${escapeAttr(part.ai_title || 'this listing')}" from your dashboard? This does <strong>not</strong> end the live eBay listing - manage that in Seller Hub.`
          : `Delete "${escapeAttr(part.ai_title || 'this draft')}"? This can't be undone.`}</p>
        <div class="popover-actions">
          <button type="button" class="secondary" data-action="cancel-delete">Cancel</button>
          <button type="button" class="danger" data-action="confirm-delete">Delete</button>
        </div>
      </div>
    </div>
    <div class="photo-gallery">
      ${galleryHtml}
      <div class="dropzone dropzone-small" data-role="add-photos">
        <p>+ Add photos</p>
        <input type="file" accept="image/*" multiple hidden />
      </div>
    </div>
    <div class="fields">
      <input type="text" data-field="ai_title" value="${escapeAttr(part.ai_title || '')}" placeholder="Title" />
      <textarea data-field="ai_description" rows="3" placeholder="Description">${part.ai_description || ''}</textarea>
      <div style="display:flex; gap:0.5rem;">
        <input type="number" step="0.01" data-field="ai_price_low" value="${part.ai_price_low ?? ''}" placeholder="Price low" />
        <input type="number" step="0.01" data-field="ai_price_high" value="${part.ai_price_high ?? ''}" placeholder="Price high" />
        <input type="number" step="1" min="1" data-field="ai_quantity" value="${part.ai_quantity ?? 1}" placeholder="Qty" style="max-width:5rem;" />
      </div>
      <select data-field="ai_condition">
        ${CONDITION_OPTIONS.map(([value, label]) =>
          `<option value="${value}" ${part.ai_condition === value ? 'selected' : ''}>${label}</option>`
        ).join('')}
      </select>
      <div class="shipping-field">
        <label style="flex-direction:row; align-items:center; gap:0.4rem;">
          <input type="checkbox" data-field="ai_free_shipping" ${part.ai_free_shipping ? 'checked' : ''} style="width:auto;" />
          Free shipping (unchecked = calculated based on buyer's location)
        </label>
        <div style="display:flex; gap:0.5rem;">
          <input type="number" step="0.1" min="0" data-field="ai_weight_lb" value="${part.ai_weight_lb ?? ''}" placeholder="Weight (lb)" />
          <input type="number" step="0.1" min="0" data-field="ai_length_in" value="${part.ai_length_in ?? ''}" placeholder="Length (in)" />
          <input type="number" step="0.1" min="0" data-field="ai_width_in" value="${part.ai_width_in ?? ''}" placeholder="Width (in)" />
          <input type="number" step="0.1" min="0" data-field="ai_height_in" value="${part.ai_height_in ?? ''}" placeholder="Height (in)" />
        </div>
      </div>
      <div class="category-field">
        <div class="category-current ${!part.ai_category_id ? 'category-missing' : ''}">
          Category: ${part.ai_category_name ? escapeAttr(part.ai_category_name) : 'not set - search below'}
        </div>
        <div class="category-search">
          <input type="text" class="category-search-input" placeholder="Search eBay categories (e.g. &quot;hydraulic filter&quot;)" />
          <button type="button" class="secondary category-search-btn">Search</button>
        </div>
        <div class="category-results"></div>
      </div>
      <div class="specifics-field">
        <label style="font-size:0.78rem; text-transform:uppercase; letter-spacing:0.06em;">Specifics</label>
        <div class="specifics-ledger" data-role="specifics-ledger">${buildSpecificsLedger(specifics)}</div>
        <button type="button" class="specifics-add" data-action="add-specific">+ Add specific</button>
      </div>
      ${part.error_message ? `<span class="error">${escapeAttr(part.error_message)}</span>` : ''}
      <div class="actions">
        <button class="secondary" data-action="save">Save edits</button>
        <button data-action="publish" ${isPublished ? 'disabled' : ''}>
          ${isPublished ? 'Delivered' : 'Ship to eBay'}
        </button>
        ${isPublished && part.ebay_listing_id
          ? `<a class="secondary" href="https://www.ebay.com/itm/${part.ebay_listing_id}" target="_blank" rel="noopener">View live listing</a>`
          : ''}
      </div>
    </div>
  `;

  card.querySelector('[data-action="save"]').addEventListener('click', () => saveDraft(part.id, card));
  card.querySelector('[data-action="publish"]').addEventListener('click', () => publishToEbay(part.id, part.ai_title));

  card.querySelectorAll('.remove-photo').forEach((btn) => {
    btn.addEventListener('click', () => removePhoto(part.id, Number(btn.dataset.index)));
  });

  const addZone = card.querySelector('[data-role="add-photos"]');
  const addInput = addZone.querySelector('input');
  setupDropzone(addZone, addInput, (files) => addPhotos(part.id, files));

  setupCategorySearch(card, part.id);
  populateConditionOptions(card, part);
  setupDeletePopover(card, part);
  setupSpecificsLedger(card);

  return card;
}

// ============================================================
// Specifics ledger — key/value rows (replaces a raw JSON textarea so
// editing item specifics reads as manifest line items, not code)
// ============================================================
function buildSpecificsLedger(specifics) {
  const entries = Object.entries(specifics);
  if (entries.length === 0) {
    return '<p class="specifics-empty" data-role="specifics-empty">No specifics yet.</p>';
  }
  return entries.map(([k, v]) => buildSpecificsRow(k, v)).join('');
}

function buildSpecificsRow(key = '', value = '') {
  return `
    <div class="specifics-row" data-role="specifics-row">
      <input type="text" class="specifics-key" placeholder="Key (e.g. Brand)" value="${escapeAttr(key)}" />
      <input type="text" class="specifics-value" placeholder="Value" value="${escapeAttr(value)}" />
      <button type="button" class="specifics-row-remove" data-action="remove-specific" title="Remove specific">&times;</button>
    </div>
  `;
}

function setupSpecificsLedger(card) {
  const ledger = card.querySelector('[data-role="specifics-ledger"]');
  const addBtn = card.querySelector('[data-action="add-specific"]');

  ledger.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="remove-specific"]');
    if (!btn) return;
    btn.closest('[data-role="specifics-row"]').remove();
    if (!ledger.querySelector('[data-role="specifics-row"]')) {
      ledger.innerHTML = '<p class="specifics-empty" data-role="specifics-empty">No specifics yet.</p>';
    }
  });

  addBtn.addEventListener('click', () => {
    const empty = ledger.querySelector('[data-role="specifics-empty"]');
    if (empty) empty.remove();
    ledger.insertAdjacentHTML('beforeend', buildSpecificsRow());
    const keys = ledger.querySelectorAll('.specifics-key');
    keys[keys.length - 1].focus();
  });
}

// ============================================================
// Draft deletion
// ============================================================
function setupDeletePopover(card, part) {
  const trigger = card.querySelector('[data-action="delete-trigger"]');
  const popover = card.querySelector('[data-role="delete-popover"]');
  const cancelBtn = card.querySelector('[data-action="cancel-delete"]');
  const confirmBtn = card.querySelector('[data-action="confirm-delete"]');

  function open() {
    popover.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onOutsideClick);
    document.addEventListener('keydown', onKeydown);
  }
  function close() {
    popover.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onOutsideClick);
    document.removeEventListener('keydown', onKeydown);
  }
  function onOutsideClick(e) {
    if (!card.contains(e.target)) close();
  }
  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    popover.classList.contains('open') ? close() : open();
  });
  cancelBtn.addEventListener('click', close);

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    try {
      const res = await fetch(`/api/parts/${part.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await describeError(res));

      close();
      if (prefersReducedMotion()) {
        card.remove();
      } else {
        card.classList.add('removing');
        card.addEventListener('animationend', () => card.remove(), { once: true });
      }
    } catch (err) {
      confirmBtn.disabled = false;
      cancelBtn.disabled = false;
      let errEl = popover.querySelector('.voyage-error-msg');
      if (!errEl) {
        errEl = document.createElement('p');
        errEl.className = 'voyage-error-msg';
        popover.insertBefore(errEl, popover.querySelector('.popover-actions'));
      }
      errEl.textContent = `Couldn't delete: ${err.message}`;
    }
  });
}

// Replaces the static condition dropdown with eBay's actual allowed conditions for this
// listing's category, labeled with eBay's own wording (e.g. "Used") - many categories (most
// Business & Industrial ones) reject this app's finer Used-Excellent/Very Good/Good/Acceptable
// grading and only accept a coarser set, so showing the real per-category options avoids picking
// one that eBay will reject at publish time. Falls back to leaving the generic list in place if
// there's no category set yet or the lookup fails.
async function populateConditionOptions(card, part) {
  if (!part.ai_category_id) return;

  let conditions;
  try {
    const res = await fetch(`/api/parts/categories/${part.ai_category_id}/conditions`);
    if (!res.ok) return;
    conditions = await res.json();
  } catch {
    return;
  }
  if (!conditions || conditions.length === 0) return;

  const select = card.querySelector('[data-field="ai_condition"]');
  const current = part.ai_condition;
  const hasCurrent = conditions.some((c) => c.value === current);
  const fallback = hasCurrent ? current : closestCondition(current, conditions);

  select.innerHTML = conditions.map(({ value, label }) =>
    `<option value="${value}" ${value === fallback ? 'selected' : ''}>${escapeAttr(label)}</option>`
  ).join('');

  if (!hasCurrent) {
    const fallbackLabel = conditions.find((c) => c.value === fallback).label;
    const note = document.createElement('div');
    note.className = 'muted';
    note.style.fontSize = '0.75rem';
    note.textContent = `Note: this listing's saved condition isn't valid for "${part.ai_category_name || part.ai_category_id}" - defaulted to "${fallbackLabel}". Save edits to apply.`;
    select.insertAdjacentElement('afterend', note);
  }
}

// When the saved condition isn't in this category's valid list, pick the closest same-tier
// option (e.g. a used condition falls back to whichever "used" option this category offers)
// rather than an arbitrary first item, which could otherwise silently suggest "New" for
// something that's actually used.
const CONDITION_FAMILIES = [
  ['NEW', 'NEW_OTHER'],
  ['SELLER_REFURBISHED'],
  ['USED_EXCELLENT', 'USED_VERY_GOOD', 'USED_GOOD', 'USED_ACCEPTABLE'],
  ['FOR_PARTS_OR_NOT_WORKING'],
];
function closestCondition(current, conditions) {
  const family = CONDITION_FAMILIES.find((f) => f.includes(current)) || [];
  const match = conditions.find((c) => family.includes(c.value));
  return (match || conditions[0]).value;
}

function setupCategorySearch(card, partId) {
  const input = card.querySelector('.category-search-input');
  const button = card.querySelector('.category-search-btn');
  const resultsEl = card.querySelector('.category-results');

  async function runSearch() {
    const q = input.value.trim();
    if (!q) return;
    resultsEl.innerHTML = '<p class="muted">Searching...</p>';

    const res = await fetch(`/api/parts/categories/suggest?q=${encodeURIComponent(q)}`);
    if (!res.ok) {
      resultsEl.innerHTML = `<p class="error">${await describeError(res)}</p>`;
      return;
    }

    const suggestions = await res.json();
    if (suggestions.length === 0) {
      resultsEl.innerHTML = '<p class="muted">No matches found.</p>';
      return;
    }

    resultsEl.innerHTML = suggestions.map((s, i) => `
      <button type="button" class="category-result" data-i="${i}">
        <strong>${escapeAttr(s.categoryName)}</strong>
        <span class="muted">${escapeAttr(s.breadcrumb)}</span>
      </button>
    `).join('');

    resultsEl.querySelectorAll('.category-result').forEach((btn, i) => {
      btn.addEventListener('click', () => selectCategory(partId, suggestions[i]));
    });
  }

  button.addEventListener('click', runSearch);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch();
    }
  });
}

async function selectCategory(id, category) {
  await fetch(`/api/parts/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ai_category_id: category.categoryId,
      ai_category_name: category.categoryName,
    }),
  });
  loadDrafts();
}

async function saveDraft(id, card) {
  const title = card.querySelector('[data-field="ai_title"]').value;
  const description = card.querySelector('[data-field="ai_description"]').value;
  const priceLow = card.querySelector('[data-field="ai_price_low"]').value;
  const priceHigh = card.querySelector('[data-field="ai_price_high"]').value;
  const quantity = card.querySelector('[data-field="ai_quantity"]').value;
  const condition = card.querySelector('[data-field="ai_condition"]').value;
  const freeShipping = card.querySelector('[data-field="ai_free_shipping"]').checked;
  const weightLb = card.querySelector('[data-field="ai_weight_lb"]').value;
  const lengthIn = card.querySelector('[data-field="ai_length_in"]').value;
  const widthIn = card.querySelector('[data-field="ai_width_in"]').value;
  const heightIn = card.querySelector('[data-field="ai_height_in"]').value;
  const specifics = {};
  card.querySelectorAll('[data-role="specifics-row"]').forEach((row) => {
    const k = row.querySelector('.specifics-key').value.trim();
    const v = row.querySelector('.specifics-value').value.trim();
    if (k) specifics[k] = v;
  });

  await fetch(`/api/parts/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ai_title: title,
      ai_description: description,
      ai_price_low: priceLow ? parseFloat(priceLow) : null,
      ai_price_high: priceHigh ? parseFloat(priceHigh) : null,
      ai_quantity: quantity ? parseInt(quantity, 10) : 1,
      ai_condition: condition,
      ai_free_shipping: freeShipping ? 1 : 0,
      ai_weight_lb: weightLb ? parseFloat(weightLb) : null,
      ai_length_in: lengthIn ? parseFloat(lengthIn) : null,
      ai_width_in: widthIn ? parseFloat(widthIn) : null,
      ai_height_in: heightIn ? parseFloat(heightIn) : null,
      ai_specifics_json: JSON.stringify(specifics),
    }),
  });
  loadDrafts();
}

// The server always returns JSON, but a failed request can still come back as something else
// entirely (a proxy's HTML error page, a 404 from a route that doesn't exist on a stale-running
// server, etc). Never assume the body parses as JSON when reporting an error.
async function describeError(res) {
  try {
    const data = await res.json();
    return data.error || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status} ${res.statusText}`;
  }
}

async function addPhotos(id, files) {
  if (files.length === 0) return;
  const formData = new FormData();
  files.forEach((f) => formData.append('photos', f));
  const res = await fetch(`/api/parts/${id}/photos`, { method: 'POST', body: formData });
  if (!res.ok) alert(`Failed to add photos: ${await describeError(res)}`);
  loadDrafts();
}

async function removePhoto(id, index) {
  const res = await fetch(`/api/parts/${id}/photos/${index}`, { method: 'DELETE' });
  if (!res.ok) alert(`Failed to remove photo: ${await describeError(res)}`);
  loadDrafts();
}

// ============================================================
// eBay shipping — voyage modal
// ============================================================
const SHIPPING_STAGES = ['Preparing cargo', 'Loading vessel', 'Crossing the bay', 'Approaching eBay', 'Delivered'];

function openModal(innerHtml) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal-panel" role="dialog" aria-modal="true" aria-label="Shipping status">${innerHtml}</div>`;
  document.body.appendChild(backdrop);
  const panel = backdrop.querySelector('.modal-panel');
  panel.setAttribute('tabindex', '-1');
  panel.focus();
  return backdrop;
}

function closeModal(backdrop) {
  backdrop.remove();
}

async function publishToEbay(id, title) {
  let allowBackdropClose = true;

  const backdrop = openModal(`
    <h3 class="reveal-on-load">Ship "${escapeAttr(title || 'this listing')}" to eBay?</h3>
    <p class="muted">This makes it LIVE and visible to real buyers on eBay immediately. This cannot be undone through this app.</p>
    <div class="modal-actions">
      <button type="button" class="secondary" data-action="cancel">Cancel</button>
      <button type="button" data-action="confirm">Confirm &amp; Ship</button>
    </div>
  `);
  revealNow(backdrop.querySelector('h3'));

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop && allowBackdropClose) closeModal(backdrop);
  });
  backdrop.querySelector('[data-action="cancel"]').addEventListener('click', () => closeModal(backdrop));

  backdrop.querySelector('[data-action="confirm"]').addEventListener('click', async () => {
    allowBackdropClose = false; // no closing mid-publish - eBay writes aren't safely abortable
    const panel = backdrop.querySelector('.modal-panel');
    panel.innerHTML = `
      <h3 class="reveal-on-load">Shipping to eBay&hellip;</h3>
      ${buildVoyageMap({ originLabel: 'Your Store', destLabel: 'eBay' })}
      ${buildStageList(SHIPPING_STAGES)}
    `;
    initVoyageMap(panel);
    revealNow(panel.querySelector('h3'));

    const stopCycle = startStageCycle(SHIPPING_STAGES.slice(0, -1), (i) => {
      updateStageList(panel, i);
    });

    try {
      const res = await fetch(`/api/parts/${id}/publish`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      stopCycle();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Publish failed');
      }

      allowBackdropClose = true;
      panel.innerHTML = `
        <div class="modal-success-icon">&#10003;</div>
        <h3 class="reveal-on-load">Cargo delivered.</h3>
        <p class="muted">"${escapeAttr(title || 'Your listing')}" is now live on eBay.</p>
        <div class="modal-actions">
          ${data.listingId ? `<a class="secondary" href="https://www.ebay.com/itm/${data.listingId}" target="_blank" rel="noopener">View live listing</a>` : ''}
          <button type="button" data-action="done">Done</button>
        </div>
      `;
      revealNow(panel.querySelector('h3'));
      panel.querySelector('[data-action="done"]').addEventListener('click', () => {
        closeModal(backdrop);
        loadDrafts();
      });
    } catch (err) {
      stopCycle();
      allowBackdropClose = true;
      panel.innerHTML = `
        <div class="modal-error-icon">!</div>
        <h3 class="reveal-on-load">The voyage hit rough water.</h3>
        <p class="voyage-error-msg">${escapeAttr(err.message)}</p>
        <div class="modal-actions">
          <button type="button" class="secondary" data-action="close">Close</button>
          <button type="button" data-action="retry">Retry</button>
        </div>
      `;
      revealNow(panel.querySelector('h3'));
      panel.querySelector('[data-action="close"]').addEventListener('click', () => {
        closeModal(backdrop);
        loadDrafts();
      });
      panel.querySelector('[data-action="retry"]').addEventListener('click', () => {
        closeModal(backdrop);
        loadDrafts().then(() => publishToEbay(id, title));
      });
    }
  });
}

function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================
// Microinteractions — buttons, cards, headings
// ============================================================

// "Magnetic" buttons: nudge a hovered button a few px toward the cursor, easing back on leave
// via the button's existing CSS transform transition. Delegated on document so dynamically
// created buttons (draft cards, modals) work without re-binding. Skipped on touch/coarse
// pointers (no hover to track) and under reduced motion.
function initButtonMagnet() {
  if (prefersReducedMotion()) return;
  if (window.matchMedia && !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  let activeBtn = null;
  document.addEventListener('pointermove', (e) => {
    const btn = e.target.closest('button:not(:disabled)');
    if (btn !== activeBtn) {
      if (activeBtn) activeBtn.style.transform = '';
      activeBtn = btn;
    }
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const dx = Math.max(-4, Math.min(4, (e.clientX - (rect.left + rect.width / 2)) * 0.15));
    const dy = Math.max(-3, Math.min(3, (e.clientY - (rect.top + rect.height / 2)) * 0.15));
    btn.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
  });
}

// Cursor-tracked spotlight highlight on draft cards (adapts "Spotlight Card", kept restrained -
// small radius, low opacity). One delegated listener on the stable list container rather than
// per-card, so it keeps working across loadDrafts() re-renders without re-binding.
function initCardSpotlight() {
  if (prefersReducedMotion()) return;
  draftsList.addEventListener('pointermove', (e) => {
    const card = e.target.closest('.draft-card');
    if (!card) return;
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${(((e.clientX - rect.left) / rect.width) * 100).toFixed(1)}%`);
    card.style.setProperty('--my', `${(((e.clientY - rect.top) / rect.height) * 100).toFixed(1)}%`);
  });
}

// Fades+lifts persistent headings (header wordmark, section titles) in once when they first
// enter the viewport - not on every scroll. Dynamically created headings (modals/overlays) use
// revealNow() directly at creation time instead, since they're already in view when created.
function initHeadingReveal() {
  const els = document.querySelectorAll('.reveal-on-load');
  if (!('IntersectionObserver' in window)) {
    els.forEach((el) => el.classList.add('revealed'));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('revealed');
        observer.unobserve(entry.target);
      }
    }
  }, { threshold: 0.15 });
  els.forEach((el) => observer.observe(el));
}

// Speeds up the header ship's CSS travel animation on hover/focus via the Web Animations API's
// playbackRate, which scales the running animation's existing timeline in place - unlike
// changing animation-duration (which recalculates position as elapsed-time / duration and jumps
// to a different point in the cycle), this keeps the ship exactly where it is and just makes it
// advance faster or slower from there, so it visibly accelerates rather than snapping.
function initBrandShipSpeed() {
  const wordmark = document.querySelector('.wordmark');
  const shipTravel = document.querySelector('.brand-ship-travel');
  if (!wordmark || !shipTravel || !shipTravel.getAnimations) return;

  const setSpeed = (rate) => {
    shipTravel.getAnimations().forEach((anim) => { anim.playbackRate = rate; });
  };
  wordmark.addEventListener('pointerenter', () => setSpeed(3.5));
  wordmark.addEventListener('pointerleave', () => setSpeed(1));
  wordmark.addEventListener('focusin', () => setSpeed(3.5));
  wordmark.addEventListener('focusout', () => setSpeed(1));
}

// ============================================================
// Account: login/signup, eBay connect gate, settings, logout
// ============================================================
let currentUser = null;

function showView(view) {
  authSection.hidden = view !== 'auth';
  connectGateSection.hidden = view !== 'connect';
  dashboard.hidden = view !== 'dashboard';
  accountBar.hidden = view === 'auth';

  const shown = view === 'auth' ? authSection : view === 'connect' ? connectGateSection : dashboard;
  const heading = shown.querySelector('.reveal-on-load');
  if (heading) revealNow(heading);
}

function setEbayBadge(connected) {
  ebayStatusBadge.textContent = connected ? 'Connected' : 'Not connected';
  ebayStatusBadge.classList.toggle('connected', connected);
  ebayStatusBadge.classList.toggle('not-connected', !connected);
}

// Runs once on load: figures out which of the three views (auth / connect-eBay / dashboard)
// the visitor should land on, based on session + eBay connection state.
async function boot() {
  handleEbayRedirectFlag();

  const { user } = await (await fetch('/api/auth/me')).json();
  currentUser = user;
  if (!user) return showView('auth');

  const ebayStatus = await (await fetch('/api/ebay/status')).json();
  setEbayBadge(ebayStatus.connected);
  if (!ebayStatus.connected) return showView('connect');

  showView('dashboard');
  loadDrafts();
}

// After eBay redirects back to "/?ebay=connected" or "/?ebay=error&reason=...", surface a
// message on the connect gate and strip the query string so a page refresh doesn't re-show it.
function handleEbayRedirectFlag() {
  const params = new URLSearchParams(window.location.search);
  const flag = params.get('ebay');
  if (!flag) return;

  const statusEl = document.getElementById('connect-gate-status');
  if (flag === 'error') {
    const reason = params.get('reason') || 'unknown_error';
    statusEl.textContent = `Couldn't connect your eBay account (${reason}). Please try again.`;
    statusEl.className = 'error';
  } else if (flag === 'connected') {
    statusEl.textContent = 'eBay account connected.';
    statusEl.className = '';
  }
  window.history.replaceState({}, '', window.location.pathname);
}

document.getElementById('show-signup').addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('login-form').hidden = true;
  document.getElementById('show-signup-wrap').hidden = true;
  document.getElementById('signup-form').hidden = false;
  document.getElementById('show-login-wrap').hidden = false;
});
document.getElementById('show-login').addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('signup-form').hidden = true;
  document.getElementById('show-login-wrap').hidden = true;
  document.getElementById('login-form').hidden = false;
  document.getElementById('show-signup-wrap').hidden = false;
});

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById('login-status');
  statusEl.textContent = '';
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  const res = await fetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) { statusEl.textContent = data.error; return; }
  boot();
});

document.getElementById('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const statusEl = document.getElementById('signup-status');
  statusEl.textContent = '';
  const email = document.getElementById('signup-email').value;
  const password = document.getElementById('signup-password').value;

  const res = await fetch('/api/auth/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) { statusEl.textContent = data.error; return; }
  boot();
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  currentUser = null;
  boot();
});

document.getElementById('connect-ebay-btn').addEventListener('click', () => {
  window.location.href = '/api/ebay/connect';
});

document.getElementById('settings-btn').addEventListener('click', openEbaySettingsModal);

async function openEbaySettingsModal() {
  const settings = await (await fetch('/api/ebay/settings')).json();

  const backdrop = openModal(`
    <h3 class="reveal-on-load">eBay Settings</h3>
    <p class="muted">Paste these from your own eBay Seller Hub (see the README for where to find each one).</p>
    <form id="ebay-settings-form">
      <label>Merchant Location Key<input type="text" name="merchantLocationKey" value="${escapeAttr(settings.merchantLocationKey)}" /></label>
      <label>Fulfillment Policy ID<input type="text" name="fulfillmentPolicyId" value="${escapeAttr(settings.fulfillmentPolicyId)}" /></label>
      <label>Payment Policy ID<input type="text" name="paymentPolicyId" value="${escapeAttr(settings.paymentPolicyId)}" /></label>
      <label>Return Policy ID<input type="text" name="returnPolicyId" value="${escapeAttr(settings.returnPolicyId)}" /></label>
      <div id="ebay-settings-status" aria-live="polite"></div>
      <div class="modal-actions">
        <button type="button" class="danger" data-action="disconnect">Disconnect eBay</button>
        <button type="button" class="secondary" data-action="close">Close</button>
        <button type="submit">Save</button>
      </div>
    </form>
  `);
  revealNow(backdrop.querySelector('h3'));

  const form = backdrop.querySelector('#ebay-settings-form');
  const statusEl = backdrop.querySelector('#ebay-settings-status');

  backdrop.querySelector('[data-action="close"]').addEventListener('click', () => closeModal(backdrop));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(backdrop); });

  backdrop.querySelector('[data-action="disconnect"]').addEventListener('click', async () => {
    if (!confirm('Disconnect your eBay account? You will need to reconnect before publishing again.')) return;
    await fetch('/api/ebay/disconnect', { method: 'POST' });
    closeModal(backdrop);
    boot();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      merchantLocationKey: form.merchantLocationKey.value.trim(),
      fulfillmentPolicyId: form.fulfillmentPolicyId.value.trim(),
      paymentPolicyId: form.paymentPolicyId.value.trim(),
      returnPolicyId: form.returnPolicyId.value.trim(),
    };
    const res = await fetch('/api/ebay/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { statusEl.textContent = data.error; statusEl.className = 'error'; return; }
    closeModal(backdrop);
    boot();
  });
}

boot();
initShipMarks();
initButtonMagnet();
initCardSpotlight();
initHeadingReveal();
initBrandShipSpeed();
