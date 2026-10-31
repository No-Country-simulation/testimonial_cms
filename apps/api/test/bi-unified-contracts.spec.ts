import { METRIC_CATALOG, METRIC_CATALOG_VERSION, metricIdSchema } from '../src/modules/business-intelligence/contracts/metric-catalog';
import {
  analyticsQuerySchema, activityQuerySchema, goalPeriodSchema, kpiDefinitionSchema,
  keyResultDefinitionSchema, manualProgressSchema, measurementSchema, objectiveDefinitionSchema,
  transitionSchema, resolveAnalyticsQuery,
} from '../src/modules/business-intelligence/contracts/unified-bi.contract';

const ownerId = '11111111-1111-4111-8111-111111111111';
const base = { title: 'Meta sintética', ownerId, from: '2026-10-01', to: '2026-12-31', baseline: '0', target: '100', filters: {} };

describe('unified BI metric catalog and contracts (not HTTP implementation)', () => {
  it('defines sixteen stable metrics with explicit lineage, units and dimensions', () => {
    expect(METRIC_CATALOG_VERSION).toBe('bi_metrics_v1');
    expect(METRIC_CATALOG.map(row => row.id)).toEqual([
      'inventory_total', 'inventory_draft', 'inventory_pending', 'inventory_approved', 'inventory_published', 'inventory_rejected',
      'average_rating', 'low_rating_share', 'published_share', 'categorized_share', 'tagged_share',
      'observed_creations', 'views', 'clicks', 'plays', 'ctr',
    ]);
    expect(METRIC_CATALOG.every(row => row.formula.length > 10 && row.lineage.length > 0 && row.owner === 'business-intelligence')).toBe(true);
    expect(METRIC_CATALOG.find(row => row.id === 'tagged_share')).toMatchObject({ requires: ['taxonomy'], unit: 'percentage', temporalScope: 'closing_snapshot' });
    expect(METRIC_CATALOG.find(row => row.id === 'ctr')).toMatchObject({ unit: 'percentage', zeroDenominator: 'unavailable', temporalScope: 'event_period' });
    expect(metricIdSchema.safeParse('revenue').success).toBe(false);
  });

  it('canonicalizes repeated filters without duplicating categories or tags', () => {
    const tagId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
    const parsed = analyticsQuerySchema.parse({ from: '2026-10-01', to: '2026-10-31', categoryId: ['none', ownerId, ownerId], tagId, status: ['published', 'draft', 'published'], source: 'widget', ratingMin: '2', ratingMax: '5' });
    expect(parsed.categoryId).toEqual([ownerId, 'none']);
    expect(parsed.tagId).toEqual([tagId.toLowerCase()]);
    expect(parsed.status).toEqual(['draft', 'published']);
    expect(parsed.source).toEqual(['widget']);
    expect(parsed).toMatchObject({ ratingMin: 2, ratingMax: 5 });
  });

  it.each([
    { from: '2026-02-30' }, { from: '2026-10-31', to: '2026-10-01' },
    { from: '2025-01-01', to: '2026-01-02' }, { tenantId: ownerId },
    { ratingMin: '4', ratingMax: '2' }, { categoryId: 'not-an-id' },
    { source: 'an-arbitrary-url' }, { tagId: Array.from({ length: 21 }, () => ownerId) },
  ])('rejects invalid or excessive analytics input %j', input => {
    expect(analyticsQuerySchema.safeParse(input).success).toBe(false);
  });

  it('permits future goal dates but rejects impossible, reversed or overlong periods', () => {
    expect(goalPeriodSchema.parse({ from: '2028-02-29', to: '2028-03-01' })).toEqual({ from: '2028-02-29', to: '2028-03-01' });
    for (const input of [{ from: '2027-02-29', to: '2027-03-01' }, { from: '2026-10-02', to: '2026-10-01' }, { from: '2026-01-01', to: '2027-01-02' }]) {
      expect(goalPeriodSchema.safeParse(input).success).toBe(false);
    }
  });

  it('resolves actual dates at the service boundary, without accepting future analytics', () => {
    const now = new Date('2026-10-31T01:00:00.000Z');
    expect(resolveAnalyticsQuery({}, now)).toMatchObject({ from: '2026-10-02', to: '2026-10-31', timezone: 'UTC' });
    expect(resolveAnalyticsQuery({ to: '2026-09-30' }, now)).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
    expect(() => resolveAnalyticsQuery({ to: '2026-11-01' }, now)).toThrow();
  });

  it('preserves exact large targets and supports increasing and decreasing KPI definitions', () => {
    expect(kpiDefinitionSchema.parse({ ...base, metricId: 'views', baseline: '9007199254740993', target: '9007199254741003' })).toMatchObject({ baseline: '9007199254740993', target: '9007199254741003', catalogVersion: 'bi_metrics_v1' });
    expect(kpiDefinitionSchema.safeParse({ ...base, metricId: 'low_rating_share', baseline: '20', target: '5' }).success).toBe(true);
  });

  it.each([
    { metricId: 'views', baseline: '1', target: '1.000' },
    { metricId: 'inventory_total', filters: { source: ['widget'] } },
    { metricId: 'views', target: '-1' }, { metricId: 'views', target: '1.5' },
    { metricId: 'published_share', target: '101' }, { metricId: 'average_rating', target: '6' },
    { metricId: 'views', target: '1e4' }, { metricId: 'views', target: 'NaN' },
    { metricId: 'views', baseline: 'not-a-number' },
    { metricId: 'views', target: '0.0000000000001' },
    { metricId: 'views', target: '10000000000000000000000000000' + '0' },
  ])('rejects invalid metric targets or meaningless dimensions %j', overrides => {
    expect(kpiDefinitionSchema.safeParse({ ...base, ...overrides }).success).toBe(false);
  });

  it('does not cap CTR at 100 percent', () => {
    expect(kpiDefinitionSchema.safeParse({ ...base, metricId: 'ctr', target: '150' }).success).toBe(true);
  });

  it('separates automatic metric configuration from manual results', () => {
    const manual = { title: 'Resultado sintético', ownerId, kind: 'manual', unit: 'number', baseline: '-10', target: '0' };
    expect(keyResultDefinitionSchema.safeParse(manual).success).toBe(true);
    expect(keyResultDefinitionSchema.safeParse({ ...manual, metricId: 'views' }).success).toBe(false);
    expect(keyResultDefinitionSchema.safeParse({ ...manual, unit: 'count', baseline: '-1' }).success).toBe(false);
    expect(keyResultDefinitionSchema.safeParse({ title: base.title, ownerId, kind: 'automatic', metricId: 'views', baseline: '0', target: '100', filters: {} }).success).toBe(true);
    expect(keyResultDefinitionSchema.safeParse({ ...manual, kind: 'automatic' }).success).toBe(false);
  });

  it('requires optimistic concurrency on advances and lifecycle commands', () => {
    const advance = { expectedVersion: 0, value: '25.125', effectiveDate: '2026-10-31', comment: 'Avance sintético' };
    expect(manualProgressSchema.parse(advance)).toEqual(advance);
    expect(manualProgressSchema.safeParse({ ...advance, expectedVersion: undefined }).success).toBe(false);
    expect(manualProgressSchema.safeParse({ ...advance, recordedById: ownerId }).success).toBe(false);
    expect(transitionSchema.parse({ expectedVersion: 2, action: 'activate' })).toEqual({ expectedVersion: 2, action: 'activate' });
    expect(transitionSchema.safeParse({ expectedVersion: 2, action: 'delete' }).success).toBe(false);
    expect(objectiveDefinitionSchema.safeParse({ title: base.title, ownerId, from: base.from, to: base.to }).success).toBe(true);
  });

  it('bounds activity independently of warehouse dimensions', () => {
    expect(activityQuerySchema.parse({ eventType: ['click', 'view'], page: '2', source: 'widget' })).toMatchObject({ page: 2, limit: 20, source: ['widget'], eventType: ['click', 'view'] });
    for (const input of [{ categoryId: ownerId }, { limit: '1000' }, { page: '0' }, { eventType: 'conversion' }]) {
      expect(activityQuerySchema.safeParse(input).success).toBe(false);
    }
  });

  it('requires a reason and null value for unavailable measurements', () => {
    expect(measurementSchema.safeParse({ status: 'available', value: '0', reason: null }).success).toBe(true);
    expect(measurementSchema.safeParse({ status: 'unavailable', value: null, reason: 'NO_CUT' }).success).toBe(true);
    expect(measurementSchema.safeParse({ status: 'unavailable', value: '0', reason: 'NO_CUT' }).success).toBe(false);
    expect(measurementSchema.safeParse({ status: 'available', value: null, reason: null }).success).toBe(false);
    expect(measurementSchema.safeParse({ status: 'unavailable', value: null, reason: null }).success).toBe(false);
  });
});
