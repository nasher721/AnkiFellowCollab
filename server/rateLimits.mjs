import rateLimit from 'express-rate-limit';

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_LIMITS = {
  uploadLimit: 5,
  syncLimit: 30,
  analyticsLimit: 60,
  readLimit: 200
};

const messages = {
  upload: 'Too many upload requests. Try again later.',
  sync: 'Too many add-on sync requests. Try again later.',
  analytics: 'Too many analytics requests. Try again later.',
  read: 'Too many read requests. Try again later.'
};

function passThrough(_req, _res, next) {
  next();
}

function rateLimitedResponse(message) {
  return {
    error: {
      code: 'rate_limited',
      message
    },
    legacyError: message
  };
}

function createLimiter({ windowMs, limit, message, skip }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip,
    handler(_req, res) {
      res.status(429).json(rateLimitedResponse(message));
    }
  });
}

function skipNonReadDeckRoutes(req) {
  if (!['GET', 'HEAD'].includes(req.method)) return true;
  return /\/(?:sync\/cards|analytics)(?:\/|$)/.test(req.path);
}

export function createRateLimiters(options = {}) {
  if (options.disabled) {
    return {
      upload: passThrough,
      sync: passThrough,
      analytics: passThrough,
      read: passThrough
    };
  }

  const windowMs = options.windowMs || DEFAULT_WINDOW_MS;
  const limits = {
    uploadLimit: options.uploadLimit || DEFAULT_LIMITS.uploadLimit,
    syncLimit: options.syncLimit || DEFAULT_LIMITS.syncLimit,
    analyticsLimit: options.analyticsLimit || DEFAULT_LIMITS.analyticsLimit,
    readLimit: options.readLimit || DEFAULT_LIMITS.readLimit
  };

  return {
    upload: createLimiter({ windowMs, limit: limits.uploadLimit, message: messages.upload }),
    sync: createLimiter({ windowMs, limit: limits.syncLimit, message: messages.sync }),
    analytics: createLimiter({ windowMs, limit: limits.analyticsLimit, message: messages.analytics }),
    read: createLimiter({
      windowMs,
      limit: limits.readLimit,
      message: messages.read,
      skip: skipNonReadDeckRoutes
    })
  };
}

export default createRateLimiters;
