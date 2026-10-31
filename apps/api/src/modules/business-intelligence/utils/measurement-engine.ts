import { Prisma } from '@prisma/client';
import type { BiMeasurement } from '../contracts/unified-bi.contract';
import { exactDecimalSchema } from '../contracts/unified-bi.contract';
import type { BiMetricValues } from '../contracts/unified-bi.types';
import { METRIC_IDS } from '../contracts/metric-catalog';

const Decimal = Prisma.Decimal.clone({ precision: 80, rounding: Prisma.Decimal.ROUND_HALF_UP });

export const missing = (reason: Extract<BiMeasurement, { status: 'unavailable' }>['reason']): BiMeasurement => ({ status: 'unavailable', value: null, reason });
export function measured(input: Prisma.Decimal.Value): BiMeasurement {
  const value = new Decimal(input);
  if (!value.isFinite()) return missing('OUT_OF_RANGE');
  const text = value.toDecimalPlaces(12).toFixed();
  return exactDecimalSchema.safeParse(text).success ? { status: 'available', value: text, reason: null } : missing('OUT_OF_RANGE');
}
export function average(sum: Prisma.Decimal.Value, count: Prisma.Decimal.Value): BiMeasurement {
  return new Decimal(count).isZero() ? missing('ZERO_DENOMINATOR') : measured(new Decimal(sum).div(count));
}
export function ratio(numerator: Prisma.Decimal.Value, denominator: Prisma.Decimal.Value): BiMeasurement {
  const divisor = new Decimal(denominator);
  return divisor.isZero() ? missing('ZERO_DENOMINATOR') : measured(new Decimal(numerator).div(divisor).times(100));
}
export function compare(current: BiMeasurement, previous: BiMeasurement) {
  if (current.status === 'unavailable') return { absolute: current, relativePercent: current };
  if (previous.status === 'unavailable') return { absolute: previous, relativePercent: previous };
  const difference = new Decimal(current.value).minus(previous.value);
  return { absolute: measured(difference), relativePercent: ratio(difference, previous.value) };
}
export function progress(current: BiMeasurement, baseline: string, target: string) {
  const base = new Decimal(baseline); const goal = new Decimal(target);
  if (!base.isFinite() || !goal.isFinite() || base.eq(goal)) throw new Error('BI_GOAL_INVALID');
  if (current.status === 'unavailable') return { progress: null, rawProgress: null };
  const raw = new Decimal(current.value).minus(base).div(goal.minus(base)).times(100);
  const serialized = measured(raw);
  if (serialized.status === 'unavailable') return { progress: null, rawProgress: null };
  return { progress: Decimal.max(0, Decimal.min(100, raw)).toDecimalPlaces(12).toFixed(), rawProgress: serialized.value };
}
export function objectiveProgress(values: Array<string | null>): string | null {
  if (!values.length || values.some(value => value === null)) return null;
  return values.reduce<Prisma.Decimal>((sum, value) => sum.plus(value!), new Decimal(0)).div(values.length).toDecimalPlaces(12).toFixed();
}
export interface MetricInputs {
  inventory: null | { total: string; draft: string; pending: string; approved: string; published: string; rejected: string; ratingSum: string; lowRating: string; categorized: string; tagged: string | null };
  engagement: null | { views: string; clicks: string; plays: string };
  creations: string | null;
  inventoryReason?: Extract<BiMeasurement, {status: 'unavailable'}>['reason'];
  engagementReason?: Extract<BiMeasurement, {status: 'unavailable'}>['reason'];
  creationsReason?: Extract<BiMeasurement, {status: 'unavailable'}>['reason'];
}
export function metricValues(input: MetricInputs): BiMetricValues {
  const unknown = missing(input.inventoryReason ?? 'NO_CUT');
  const result = Object.fromEntries(METRIC_IDS.map(id => [id, unknown])) as BiMetricValues;
  const inventory = input.inventory;
  if (inventory) {
    result.inventory_total = measured(inventory.total);
    result.inventory_draft = measured(inventory.draft); result.inventory_pending = measured(inventory.pending);
    result.inventory_approved = measured(inventory.approved); result.inventory_published = measured(inventory.published); result.inventory_rejected = measured(inventory.rejected);
    result.average_rating = new Decimal(inventory.total).isZero() ? missing('ZERO_DENOMINATOR') : measured(new Decimal(inventory.ratingSum).div(inventory.total));
    result.low_rating_share = ratio(inventory.lowRating, inventory.total);
    result.published_share = ratio(inventory.published, inventory.total);
    result.categorized_share = ratio(inventory.categorized, inventory.total);
    result.tagged_share = inventory.tagged === null ? missing('TAGS_NOT_OBSERVED') : ratio(inventory.tagged, inventory.total);
  }
  result.observed_creations = input.creations === null ? missing(input.creationsReason ?? 'CREATIONS_NOT_OBSERVED') : measured(input.creations);
  const events = input.engagement;
  result.views = events ? measured(events.views) : missing(input.engagementReason ?? 'OUTSIDE_COVERAGE');
  result.clicks = events ? measured(events.clicks) : missing(input.engagementReason ?? 'OUTSIDE_COVERAGE');
  result.plays = events ? measured(events.plays) : missing(input.engagementReason ?? 'OUTSIDE_COVERAGE');
  result.ctr = events ? ratio(events.clicks, events.views) : missing(input.engagementReason ?? 'OUTSIDE_COVERAGE');
  return result;
}
