// Makes the "Bali Bay" logo (id="brand-link") route to the dashboard when logged in, or the
// landing page when logged out. Shared across every page since login state can only be known
// client-side (no server-rendered templates here).
(function () {
  var link = document.getElementById('brand-link');
  if (!link) return;

  link.addEventListener('click', function (e) {
    // Let modified clicks (new tab, new window) behave normally instead of racing the fetch below.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();

    fetch('/api/auth/me')
      .then(function (res) { return res.ok ? res.json() : { user: null }; })
      .catch(function () { return { user: null }; })
      .then(function (data) {
        window.location.href = (data && data.user) ? '/app.html' : '/';
      });
  });
})();
