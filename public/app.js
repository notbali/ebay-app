const form = document.getElementById('upload-form');
const statusEl = document.getElementById('upload-status');
const draftsList = document.getElementById('drafts-list');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  statusEl.textContent = 'Generating listing with Gemini... (this can take 10-20s)';
  statusEl.className = '';

  const formData = new FormData(form);
  try {
    const res = await fetch('/api/parts', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to generate listing');

    statusEl.textContent = `Draft created. Confidence: ${data.part.ai_confidence}. ${data.notes_for_seller || ''}`;
    form.reset();
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

  card.innerHTML = `
    ${part.photo_path
      ? `<img src="/${part.photo_path.replace(/^.*uploads/, 'uploads')}" alt="part photo" />`
      : `<div class="placeholder">No photo</div>`}
    <div class="fields">
      <span class="badge ${part.ai_confidence || ''}">${part.ai_confidence || 'unknown'} confidence &middot; ${part.status}</span>
      <input type="text" data-field="ai_title" value="${escapeAttr(part.ai_title || '')}" placeholder="Title" />
      <textarea data-field="ai_description" rows="3" placeholder="Description">${part.ai_description || ''}</textarea>
      <div style="display:flex; gap:0.5rem;">
        <input type="number" step="0.01" data-field="ai_price_low" value="${part.ai_price_low ?? ''}" placeholder="Price low" />
        <input type="number" step="0.01" data-field="ai_price_high" value="${part.ai_price_high ?? ''}" placeholder="Price high" />
      </div>
      <textarea data-field="ai_specifics_json" rows="2" placeholder="Specifics (key: value per line)">${specificsText}</textarea>
      ${part.error_message ? `<span class="error">${escapeAttr(part.error_message)}</span>` : ''}
      <div class="actions">
        <button class="secondary" data-action="save">Save edits</button>
        <button data-action="push" ${part.status === 'pushed_to_ebay' || part.status === 'published' ? 'disabled' : ''}>
          ${part.status === 'pushed_to_ebay' || part.status === 'published' ? 'Pushed to eBay' : 'Push to eBay (draft)'}
        </button>
      </div>
    </div>
  `;

  card.querySelector('[data-action="save"]').addEventListener('click', () => saveDraft(part.id, card));
  card.querySelector('[data-action="push"]').addEventListener('click', () => pushToEbay(part.id));

  return card;
}

async function saveDraft(id, card) {
  const title = card.querySelector('[data-field="ai_title"]').value;
  const description = card.querySelector('[data-field="ai_description"]').value;
  const priceLow = card.querySelector('[data-field="ai_price_low"]').value;
  const priceHigh = card.querySelector('[data-field="ai_price_high"]').value;
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
      ai_specifics_json: JSON.stringify(specifics),
    }),
  });
  loadDrafts();
}

async function pushToEbay(id) {
  const res = await fetch(`/api/parts/${id}/push-to-ebay`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) alert(`Failed to push to eBay: ${data.error}`);
  loadDrafts();
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}

loadDrafts();
