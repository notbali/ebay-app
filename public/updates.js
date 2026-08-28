const listEl = document.getElementById('updates-list');
const panelEl = document.getElementById('new-update-panel');
const formEl = document.getElementById('new-update-form');
const statusEl = document.getElementById('new-update-status');

let isAdmin = false;

function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const EXCERPT_LENGTH = 140;

function excerpt(body) {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  return oneLine.length > EXCERPT_LENGTH ? `${oneLine.slice(0, EXCERPT_LENGTH).trim()}…` : oneLine;
}

function renderList(updates) {
  if (updates.length === 0) {
    listEl.innerHTML = '<p class="muted">Nothing posted yet.</p>';
    return;
  }

  listEl.innerHTML = updates.map((u) => `
    <article class="update-card">
      <a href="update.html?id=${u.id}" class="update-card-link">
        <span class="update-card-date">Update: ${formatUpdateDateShort(u.created_at)}</span>
        <h3>${escapeAttr(u.title)}</h3>
        <p>${escapeAttr(excerpt(u.body))}</p>
      </a>
      ${isAdmin ? `<button type="button" class="danger small" data-action="delete-update" data-id="${u.id}">Delete</button>` : ''}
    </article>
  `).join('');

  listEl.querySelectorAll('[data-action="delete-update"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      await fetch(`/api/updates/${btn.dataset.id}`, { method: 'DELETE' });
      loadUpdates();
    });
  });
}

async function loadUpdates() {
  const res = await fetch('/api/updates');
  renderList(res.ok ? await res.json() : []);
}

formEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  statusEl.textContent = '';
  const res = await fetch('/api/updates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: formEl.title.value, body: formEl.body.value }),
  });
  const data = await res.json();
  if (!res.ok) { statusEl.textContent = data.error; return; }
  formEl.reset();
  loadUpdates();
});

async function init() {
  const { user } = await (await fetch('/api/auth/me')).json();
  isAdmin = !!(user && user.isAdmin);
  panelEl.hidden = !isAdmin;
  loadUpdates();
}

init();
