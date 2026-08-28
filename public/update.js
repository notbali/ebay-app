const detailEl = document.getElementById('update-detail');

function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderNotFound() {
  detailEl.innerHTML = '<p class="muted">That update couldn\'t be found.</p>';
}

function renderUpdate(update) {
  detailEl.innerHTML = `
    <span class="update-card-date">Update: ${formatUpdateDateFull(update.created_at)}</span>
    <h2>${escapeAttr(update.title)}</h2>
    <p class="update-detail-body">${escapeAttr(update.body)}</p>
  `;
}

async function init() {
  const id = new URLSearchParams(window.location.search).get('id');
  if (!id) { renderNotFound(); return; }

  const res = await fetch(`/api/updates/${encodeURIComponent(id)}`);
  if (!res.ok) { renderNotFound(); return; }
  renderUpdate(await res.json());
}

init();
