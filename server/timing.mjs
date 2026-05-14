export function createTimingMiddleware() {
  return (req, res, next) => {
    const start = Date.now();
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    res.json = function (body) {
      res.set('X-Response-Time', `${Date.now() - start}ms`);
      return originalJson(body);
    };
    res.send = function (body) {
      res.set('X-Response-Time', `${Date.now() - start}ms`);
      return originalSend(body);
    };
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (process.env.DECKBRIDGE_TIMING_LOG) {
        console.log(`[timing] ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
      }
    });
    next();
  };
}
