import { ApiError } from '../lib/ApiError.js';

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: { message: 'Route not found', code: 'not_found' } });
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
export function errorHandler(error, _req, res, _next) {
  const status = error instanceof ApiError ? error.status : 500;
  if (status >= 500) {
    console.error(error);
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
