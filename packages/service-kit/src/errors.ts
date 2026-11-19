import type { ErrorBody } from '@kosh/contracts';

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) } };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

export const badRequest = (code: string, message: string, details?: unknown) => new AppError(400, code, message, details);
export const unauthorized = (code: string, message: string) => new AppError(401, code, message);
export const forbidden = (code: string, message: string) => new AppError(403, code, message);
export const notFound = (code: string, message: string) => new AppError(404, code, message);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) => new AppError(422, code, message, details);
export const locked = (code: string, message: string, details?: unknown) => new AppError(423, code, message, details);
export const tooMany = (code: string, message: string, details?: unknown) => new AppError(429, code, message, details);
export const unavailable = (code: string, message: string) => new AppError(503, code, message);
