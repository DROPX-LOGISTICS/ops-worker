import { AMOUNT_EPSILON } from '../config';

/** True if `value` is within epsilon of zero (guards against float noise like 0.0000000058208). */
export function isZero(value: number | null | undefined, epsilon: number = AMOUNT_EPSILON): boolean {
  if (value === null || value === undefined) return true;
  return Math.abs(value) < epsilon;
}

export function approxEqual(a: number, b: number, epsilon: number = AMOUNT_EPSILON): boolean {
  return Math.abs(a - b) < epsilon;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
