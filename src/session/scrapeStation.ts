import type { Env } from '../types';

/**
 * Station used ONLY to open the portal UI and fire proxyapigateway while
 * capturing cookie + x-api-usage-key. Frontend validate calls use their own
 * stationCode afterwards — never this value for business logic.
 */
export function scrapeStationCode(env: Env, defaultStationCode?: string): string {
  return (defaultStationCode || env.AMAZON_LOGIN_STATION_CODE || 'TIRC').trim().toUpperCase();
}
