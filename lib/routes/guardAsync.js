'use strict';
// Express 4 does not catch a rejected async route handler: the request hangs
// and the unhandled rejection can stop the process. guardRouter(router) makes
// every route added afterwards answer 500 with the request reference instead,
// and log the failure once with what is needed to trace it (request id, user,
// route, error class) — never request bodies or financial figures.

function failed(req, res, where, e, message = 'Something went wrong') {
  res.locals.errorMessage = `${where}: ${e?.code || e?.name || 'Error'}`;
  console.error('[route]', JSON.stringify({
    requestId: req.requestId || null, userId: req.user?.userId || null, route: where,
    error: String(e?.message || e).slice(0, 300),
  }));
  if (!res.headersSent) res.status(500).json({ error: message, requestId: req.requestId || null });
}

function guardRouter(router) {
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
    const add = router[m].bind(router);
    router[m] = (path, ...handlers) => add(path, ...handlers.map((h) => (req, res, next) =>
      Promise.resolve().then(() => h(req, res, next)).catch((e) => failed(req, res, `${req.method} ${path}`, e))));
  }
  return router;
}

module.exports = { guardRouter, failed };
