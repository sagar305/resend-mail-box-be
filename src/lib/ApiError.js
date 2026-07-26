export class ApiError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}
