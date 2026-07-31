import type { ErrorHandler } from 'hono';
import { ProviderError, ValidationInputError } from '../errors';

/**
 * Central error -> HTTP mapping. Handlers/services just throw typed errors;
 * this is the only place that knows how those become status codes.
 */
export const errorHandler: ErrorHandler = (err, c) => {
  console.error(err);

  if (err instanceof ValidationInputError) {
    return c.json({ error: err.message, code: err.code }, 400);
  }
  if (err instanceof ProviderError) {
    // Hono's status param type is a closed literal union across all valid
    // HTTP codes; ProviderError.status is a plain number by design (keeps
    // errors.ts framework-agnostic), so we cast at this single boundary.
    return c.json({ error: err.message, code: err.code }, err.status as Parameters<typeof c.json>[1]);
  }

  return c.json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }, 500);
};
