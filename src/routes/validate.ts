import type { Context } from 'hono';
import type { Env, ValidateRequestBody } from '../types';
import { runValidationPipeline } from '../services/validationPipeline';
import { createStationDataProvider } from '../providers/factory';
import { createOverrideStore } from '../store/factory';
import { ValidationInputError } from '../errors';

export async function validateHandler(c: Context<{ Bindings: Env }>) {
  let body: ValidateRequestBody;
  try {
    body = await c.req.json<ValidateRequestBody>();
  } catch {
    throw new ValidationInputError('Request body must be valid JSON');
  }

  const provider = createStationDataProvider(c.env);
  const store = createOverrideStore(c.env);

  const result = await runValidationPipeline(body, provider, store, c.env);

  // 200 when clear to proceed, 409 (Conflict) when blocked on an
  // unresolved check — lets the frontend branch on status code alone.
  return c.json(result, result.status === 'passed' ? 200 : 409);
}
