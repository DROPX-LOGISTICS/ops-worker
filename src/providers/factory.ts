import type { Env } from '../types';
import type { StationDataProvider } from './StationDataProvider';
import { AmazonLogisticsProvider } from './AmazonLogisticsProvider';

/**
 * Single place that decides which StationDataProvider backs the pipeline.
 * To point at a different backend (a REST service you own, a mock for
 * tests, another region's portal, etc.), add a case here and implement
 * StationDataProvider — nothing else in the codebase needs to change.
 */
export function createStationDataProvider(env: Env): StationDataProvider {
  switch (env.DATA_PROVIDER) {
    case 'amazon':
    default:
      return new AmazonLogisticsProvider(env.AMAZON_PROXY_BASE_URL);
  }
}
