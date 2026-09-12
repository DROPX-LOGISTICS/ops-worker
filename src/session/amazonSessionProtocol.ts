import type { SupabaseClient } from '@supabase/supabase-js';

type RpcError = { code?: string; message?: string } | null;
/** Retried writes must use the same lease/session UUID after an uncertain reply. */
export async function amazonSessionRpc(
  client: SupabaseClient, name: string, args: Record<string, unknown>,
): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let result: { data: unknown; error: RpcError };
    try {
      result = await client.rpc(name, args) as { data: unknown; error: RpcError };
    } catch {
      if (attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 400));
        continue;
      }
      throw new Error(`Amazon session operation ${name} failed (transport).`);
    }
    const { data, error } = result;
    if (!error) return data;
    if (attempt === 0 && !['P0001', '22023', '42501', '42883', 'PGRST202'].includes(error.code ?? '')) {
      await new Promise(resolve => setTimeout(resolve, 400));
      continue;
    }
    // Do not log RPC arguments: session calls contain credentials.
    throw new Error(`Amazon session operation ${name} failed (${error.code ?? 'transport'}).`);
  }
  throw new Error('Amazon session store unavailable.');
}

export const AMAZON_LOGIN_LEASE_SECONDS = 300;
export const AMAZON_BROWSER_LOGIN_TIMEOUT_MS = 150_000;
export function loginFailureCooldown(message: string): number {
  if (/rate limit exceeded|429|too many requests|browser time|MFA|OTP|captcha/i.test(message)) return 900;
  return 60;
}
