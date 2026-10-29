import type { ErrorCode } from '@aquarium/protocol';
export class AppError extends Error {
  constructor(public code: ErrorCode, message: string, public status = 409) { super(message); }
}
export function assert(condition: unknown, code: ErrorCode, message: string, status = 409): asserts condition {
  if (!condition) throw new AppError(code, message, status);
}
