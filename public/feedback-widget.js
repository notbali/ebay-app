// Standing feedback box, mounted into a `<div id="feedback-widget">` in every page's footer
// (see index.html/terms.html/privacy.html/updates.html) - one shared script instead of copying
// this logic into each page, and one fewer click than the old "Feedback" button + modal.
(function () {
  function escapeAttr(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function buildLoggedInBox() {
    const box = document.createElement('div');
    box.className = 'feedback-box';
    box.innerHTML = `
      <h4>Send Feedback</h4>
      <p class="muted">Tell us what's working, what's not, or what you'd like to see.</p>
      <form id="footer-feedback-form">
        <textarea name="message" rows="3" maxlength="5000" placeholder="Your feedback..." required></textarea>
        <div class="feedback-box-actions">
          <div id="footer-feedback-status" aria-live="polite"></div>
          <button type="submit">Send</button>
        </div>
      </form>
    `;
    return box;
  }

  function buildLoggedOutBox() {
    const box = document.createElement('div');
    box.className = 'feedback-box';
    box.innerHTML = `
      <h4>Send Feedback</h4>
      <p class="muted">Log in to send feedback.</p>
    `;
    return box;
  }

  function wireForm(box) {
    const form = box.querySelector('#footer-feedback-form');
    const statusEl = box.querySelector('#footer-feedback-status');
    const textarea = form.querySelector('textarea');
    const submitBtn = form.querySelector('button[type="submit"]');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      statusEl.textContent = '';
      statusEl.className = '';
      submitBtn.disabled = true;

      try {
        const res = await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: textarea.value }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to send feedback');

        statusEl.textContent = 'Thanks — sent.';
        statusEl.className = 'feedback-sent';
        form.reset();
      } catch (err) {
        statusEl.textContent = escapeAttr(err.message);
        statusEl.className = 'error';
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  async function init() {
    const mount = document.getElementById('feedback-widget');
    if (!mount) return;

    let user = null;
    try {
      const res = await fetch('/api/auth/me');
      const data = await res.json();
      user = data.user;
    } catch {
      // Network hiccup - fall through as logged-out rather than blocking the rest of the page.
    }

    const box = user ? buildLoggedInBox() : buildLoggedOutBox();
    mount.appendChild(box);
    if (user) wireForm(box);
  }

  init();
})();
