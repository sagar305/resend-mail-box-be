import { config } from '../config.js';
import { ApiError } from '../lib/ApiError.js';

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: { message: 'Route not found', code: 'not_found' } });
}

/**
 * express.json() rejects a body before any route sees it. Left alone that surfaces
 * as an opaque 500, which is a poor way to find out an attachment was too big, so
 * these are translated into the shape a route would have produced.
 */
function translateBodyParserError(error) {
  if (error?.type === 'entity.too.large') {
    const megabytes = (config.attachments.maxTotalBytes / (1024 * 1024)).toFixed(0);
    return new ApiError(
      413,
      `The message is too large to send. Attachments must total ${megabytes} MB or less.`,
      'payload_too_large',
    );
  }
  if (error?.type === 'entity.parse.failed') {
    return new ApiError(400, 'Malformed JSON body', 'invalid_json');
  }
  return error;
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
export function errorHandler(rawError, _req, res, _next) {
  const error = translateBodyParserError(rawError);
  const status = error instanceof ApiError ? error.status : 500;
  // Log stacks only for genuine surprises. A deliberate ApiError — an upstream
  // 502, a 503 while the database reconnects — already says what happened, and
  // dumping its stack on every polled request buries the real problems.
  if (!(error instanceof ApiError)) {
    console.error(error);
  } else if (status >= 500) {
    console.error(`[${status}] ${error.code ?? 'error'}: ${error.message}`);
  }
  res.status(status).json({
    error: {
      message: status >= 500 && !(error instanceof ApiError)
        ? 'Something went wrong'
        : error.message,
      code: error.code ?? null,
    },
  });
}
