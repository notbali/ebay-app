// A hand-written subset of what a package like helmet would set, rather than adding the
// dependency for three headers. Deliberately skips a Content-Security-Policy here - this app
// loads Google Fonts and relies on inline event handlers being absent rather than CSP-enforced,
// and getting a CSP wrong silently breaks rendering in ways that are easy to miss without a full
// manual pass over every page; worth adding later with real browser verification, not guessed at.
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

module.exports = { securityHeaders };
