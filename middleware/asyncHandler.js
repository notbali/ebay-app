// Express 4 doesn't catch a rejected promise from an async route handler - the rejection goes
// unhandled and can take the whole process down (Node exits on unhandled rejections) instead of
// producing an error response. Wrapping a handler forwards a rejection to next(err), which lands
// in server.js's generic error handler like any synchronous throw would.
function asyncHandler(fn) {
  return (req, res, next) => {
    // The executor form also turns a synchronous throw into a rejection, so both reach next().
    new Promise((resolve) => resolve(fn(req, res, next))).catch(next);
  };
}

module.exports = { asyncHandler };
