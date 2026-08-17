const form = document.getElementById('upload-form');
const statusEl = document.getElementById('upload-status');
const draftsList = document.getElementById('drafts-list');
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

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  statusEl.textContent = 'Generating listing with Claude... (this can take 10-20s)';
  statusEl.className = '';

  const formData = new FormData();
  selectedFiles.forEach((file) => formData.append('photos', file));
  formData.append('notes', document.getElementById('notes-input').value);

  try {
    const res = await fetch('/api/parts', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to generate listing');

    statusEl.textContent = `Draft created. Confidence: ${data.part.ai_confidence}. ${data.notes_for_seller || ''}`;
    form.reset();
    selectedFiles = [];
    renderSelectedFiles();
    loadDrafts();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.className = 'error';
  }
});

async function loadDrafts() {
  const res = await fetch('/api/parts');
  const parts = await res.json();
  draftsList.innerHTML = '';

  if (parts.length === 0) {
    draftsList.innerHTML = '<p style="color:#6b6b6b">No drafts yet.</p>';
    return;
  }

  for (const part of parts) {
    draftsList.appendChild(renderDraftCard(part));
  }
}

function renderDraftCard(part) {
  const card = document.createElement('div');
  card.className = 'draft-card';

  const specifics = JSON.parse(part.ai_specifics_json || '{}');
  const specificsText = Object.entries(specifics).map(([k, v]) => `${k}: ${v}`).join('\n');
  const photoPaths = JSON.parse(part.photo_paths_json || '[]');
  const isPublished = part.status === 'published';

  const galleryHtml = photoPaths.length > 0
    ? photoPaths.map((p, i) => `
        <div class="thumb">
          <img src="/${p.replace(/^.*uploads/, 'uploads')}" alt="part photo ${i + 1}" />
          <button type="button" class="remove-photo" data-index="${i}" title="Remove photo">&times;</button>
        </div>
      `).join('')
    : '<div class="placeholder">No photos</div>';

  card.innerHTML = `
    <div class="photo-gallery">
      ${galleryHtml}
      <div class="dropzone dropzone-small" data-role="add-photos">
        <p>+ Add photos</p>
        <input type="file" accept="image/*" multiple hidden />
      </div>
    </div>
    <div class="fields">
      <span class="badge ${part.ai_confidence || ''}">${part.ai_confidence || 'unknown'} confidence &middot; ${part.status}</span>
      <input type="text" data-field="ai_title" value="${escapeAttr(part.ai_title || '')}" placeholder="Title" />
      <textarea data-field="ai_description" rows="3" placeholder="Description">${part.ai_description || ''}</textarea>
      <div style="display:flex; gap:0.5rem;">
        <input type="number" step="0.01" data-field="ai_price_low" value="${part.ai_price_low ?? ''}" placeholder="Price low" />
        <input type="number" step="0.01" data-field="ai_price_high" value="${part.ai_price_high ?? ''}" placeholder="Price high" />
      </div>
      <select data-field="ai_condition">
        ${CONDITION_OPTIONS.map(([value, label]) =>
          `<option value="${value}" ${part.ai_condition === value ? 'selected' : ''}>${label}</option>`
        ).join('')}
      </select>
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
      <textarea data-field="ai_specifics_json" rows="2" placeholder="Specifics (key: value per line)">${specificsText}</textarea>
      ${part.error_message ? `<span class="error">${escapeAttr(part.error_message)}</span>` : ''}
      <div class="actions">
        <button class="secondary" data-action="save">Save edits</button>
        <button data-action="publish" ${isPublished ? 'disabled' : ''}>
          ${isPublished ? 'Published (live)' : 'Publish to eBay'}
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

  return card;
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
  const condition = card.querySelector('[data-field="ai_condition"]').value;
  const specificsText = card.querySelector('[data-field="ai_specifics_json"]').value;

  const specifics = {};
  specificsText.split('\n').forEach((line) => {
    const [k, ...rest] = line.split(':');
    if (k && rest.length) specifics[k.trim()] = rest.join(':').trim();
  });

  await fetch(`/api/parts/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ai_title: title,
      ai_description: description,
      ai_price_low: priceLow ? parseFloat(priceLow) : null,
      ai_price_high: priceHigh ? parseFloat(priceHigh) : null,
      ai_condition: condition,
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

async function publishToEbay(id, title) {
  const confirmed = confirm(
    `Publish "${title || 'this listing'}"?\n\nThis makes it LIVE and visible to real buyers on eBay immediately. ` +
    'This cannot be undone through this app.'
  );
  if (!confirmed) return;

  const res = await fetch(`/api/parts/${id}/publish`, { method: 'POST' });
  if (!res.ok) alert(`Failed to publish: ${await describeError(res)}`);
  loadDrafts();
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}

loadDrafts();
