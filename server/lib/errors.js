export class AppError extends Error {
  constructor(status, code, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.expose = options.expose ?? status < 500;
  }
}

export function notFound(resource = 'Resource') {
  return new AppError(404, 'NOT_FOUND', `${resource} was not found.`);
}

export function validation(message) {
  return new AppError(400, 'VALIDATION_ERROR', message);
}

export function conflict(message) {
  return new AppError(409, 'CONFLICT', message);
}
