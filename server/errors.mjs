export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function fail(status, code, message) {
  throw new AppError(status, code, message);
}

export function errorPayload(error, production = false) {
  const status = error.status || 500;
  const code = error.code || (status === 500 ? 'internal_error' : 'request_error');
  const message = status === 500 && production ? 'Unexpected server error' : error.message || 'Unexpected server error';
  return { status, body: { error: { code, message } } };
}
