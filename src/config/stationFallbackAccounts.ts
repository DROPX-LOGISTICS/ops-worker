/** Generated from the SCC credential workbook; primary authentication remains `default`. */
export const STATION_PORTAL_FALLBACK_ACCOUNTS: Readonly<Record<string, readonly string[]>> = {
  GDRD: ['fallback-GDRD-1'], GNTF: ['fallback-GNTF-1', 'fallback-GNTF-2'],
  GNTI: ['fallback-GNTI-1', 'fallback-GNTI-2'], GYMC: ['fallback-GYMC-1'],
  JDBD: ['fallback-JDBD-1', 'fallback-JDBD-2', 'fallback-JDBD-3'], JGBA: ['fallback-JGBA-1'],
  JUGD: ['fallback-JUGD-1'], JUGF: ['fallback-JUGF-1'], KANA: ['fallback-KANA-1'],
  KBWE: ['fallback-KBWE-1'], KDJE: ['fallback-KDJE-1'], KDJG: ['fallback-KDJG-1'],
  KGQA: ['fallback-KGQA-1'], KGQC: ['fallback-KGQC-1'], KGQE: ['fallback-KGQE-1'],
  KLZA: ['fallback-KLZA-1'], KLZH: ['fallback-KLZH-1'], KOZA: ['fallback-KOZA-1'],
  KTUB: ['fallback-KTUB-1'], KTUO: ['fallback-KTUO-1'], KTUR: ['fallback-KTUR-1'],
  NLRC: ['fallback-NLRC-1', 'fallback-NLRC-2'], NLRE: ['fallback-NLRE-1'], NLRF: ['fallback-NLRF-1', 'fallback-NLRF-2'],
  PEUA: ['fallback-PEUA-1'], QLDA: ['fallback-QLDA-1'], RPRN: ['fallback-RPRN-1'],
  SPBE: ['fallback-SPBE-1'], TIRC: ['fallback-TIRC-1'], TLPA: ['fallback-TLPA-1'],
  TLPB: ['fallback-TLPB-1'], XAPH: ['fallback-XAPH-1'], XAPI: ['fallback-XAPI-1'],
  XAPL: ['fallback-XAPL-1', 'fallback-XAPL-2'],
};

export function portalFallbackAccountKeysForStation(stationCode?: string | null): readonly string[] {
  return STATION_PORTAL_FALLBACK_ACCOUNTS[(stationCode ?? '').trim().toUpperCase()] ?? [];
}
