// Pure routing/error-formatting decisions, kept separate from server.js so they're testable
// without spinning up a live HTTP server (same pattern as the other services/*).

function isApiRequest(path) {
  return typeof path === 'string' && path.startsWith('/api/');
}

// Only trusts a status set explicitly on the error object, and only within the valid HTTP
// error range - anything else (missing, non-numeric, or out of range) defaults to 500 rather
// than leaking something like a stray 200 or a bogus value onto the response.
function statusForError(err) {
  const status = err ? (err.status ?? err.statusCode) : undefined;
  return Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
}

module.exports = { isApiRequest, statusForError };
