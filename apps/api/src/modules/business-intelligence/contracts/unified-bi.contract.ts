import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { dateRange } from '../dtos/dashboard-query.dto';
import { METRIC_CATALOG_VERSION, metricDefinition, metricIdSchema, type MetricId } from './metric-catalog';

/** Phase 1 contract. Controllers/repositories are intentionally added in later phases. */
export const utcDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const at = new Date(`${value}T00:00:00.000Z`);
  return value >= '0001-01-01' && Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === value;
}, 'Fecha UTC inválida');
export const exactDecimalSchema = z.string().max(42).refine(value => {
  const unsigned = value.startsWith('-') ? value.slice(1) : value;
  const [integer, fraction, ...extra] = unsigned.split('.');
  return extra.length === 0 && integer !== undefined && integer.length >= 1 && integer.length <= 28 &&
    /^[0-9]+$/.test(integer) && (integer.length === 1 || integer[0] !== '0') &&
    (fraction === undefined || (fraction.length >= 1 && fraction.length <= 12 && /^[0-9]+$/.test(fraction)));
}, 'Decimal exacto: hasta 28 enteros y 12 decimales, sin exponente');
const uuid = z.uuid().transform(value => value.toLowerCase());
const dimensionId = z.union([uuid, z.literal('none')]);
export const testimonialStateSchema = z.enum(['draft', 'pending', 'approved', 'published', 'rejected']);
export const sourceCodeSchema = z.enum(['public', 'public-browser', 'api', 'widget', 'other']);
export const eventTypeSchema = z.enum(['view', 'click', 'play']);
const title = z.string().trim().min(1).max(120);
const version = z.number().int().min(0).max(2147483646);
const rating = z.preprocess(value => typeof value === 'string' && /^[1-5]$/.test(value) ? Number(value) : value, z.number().int().min(1).max(5));
function selections<T extends z.ZodType>(item: T, maximum: number) {
  return z.preprocess(value => value === undefined ? [] : Array.isArray(value) ? value : [value],
    z.array(item).max(maximum).transform(values => [...new Set(values)].sort()));
}
const scopeFields = {
  categoryId: selections(dimensionId, 20), tagId: selections(dimensionId, 20),
  status: selections(testimonialStateSchema, 5), source: selections(sourceCodeSchema, 5),
  ratingMin: rating.optional(), ratingMax: rating.optional(),
};
function validRatings(value: { ratingMin?: number | undefined; ratingMax?: number | undefined }, ctx: z.RefinementCtx) {
  if (value.ratingMin !== undefined && value.ratingMax !== undefined && value.ratingMin > value.ratingMax)
    ctx.addIssue({ code: 'custom', path: ['ratingMax'], message: 'El máximo no puede ser menor que el mínimo' });
}
function validPeriod(value: { from?: string | undefined; to?: string | undefined }, ctx: z.RefinementCtx) {
  if (value.from && value.to) {
    const days = (Date.parse(value.to) - Date.parse(value.from)) / 86400000 + 1;
    if (!Number.isFinite(days) || days < 1 || days > 366)
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'El período debe contener entre 1 y 366 días UTC' });
  }
}
export const filterScopeSchema = z.object(scopeFields).strict().superRefine(validRatings);
export type BiFilterScope = z.infer<typeof filterScopeSchema>;
export const analyticsQuerySchema = z.object({ from: utcDaySchema.optional(), to: utcDaySchema.optional(), ...scopeFields })
  .strict().superRefine(validPeriod).superRefine(validRatings);
export type BiAnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
/** Same 30-day/default/future-date rules as the existing BI dashboard. */
export function resolveAnalyticsQuery(input: unknown, now = new Date()) {
  const parsed = analyticsQuerySchema.parse(input);
  return { ...parsed, ...dateRange({ ...(parsed.from ? { from: parsed.from } : {}), ...(parsed.to ? { to: parsed.to } : {}) }, now) };
}
export const goalPeriodSchema = z.object({ from: utcDaySchema, to: utcDaySchema }).strict().superRefine(validPeriod);
const periodFields = { from: utcDaySchema, to: utcDaySchema };
const metricFields = {
  metricId: metricIdSchema, catalogVersion: z.literal(METRIC_CATALOG_VERSION).default(METRIC_CATALOG_VERSION),
  baseline: exactDecimalSchema, target: exactDecimalSchema, filters: filterScopeSchema,
};
function differentTarget(value: { baseline: string; target: string }, ctx: z.RefinementCtx) {
  if (!exactDecimalSchema.safeParse(value.baseline).success || !exactDecimalSchema.safeParse(value.target).success) return;
  if (new Prisma.Decimal(value.baseline).eq(value.target)) ctx.addIssue({ code: 'custom', path: ['target'], message: 'La meta debe diferir del valor inicial' });
}
function validMetricDefinition(value: { metricId: MetricId; baseline: string; target: string; filters: BiFilterScope }, ctx: z.RefinementCtx) {
  differentTarget(value, ctx);
  const definition = metricDefinition(value.metricId);
  if (value.filters.source.length && !definition.dimensions.includes('source'))
    ctx.addIssue({ code: 'custom', path: ['filters', 'source'], message: 'Fuente sólo aplica a métricas de engagement' });
  for (const [key, text] of [['baseline', value.baseline], ['target', value.target]] as const) {
    if (!exactDecimalSchema.safeParse(text).success) continue;
    const amount = new Prisma.Decimal(text);
    if (amount.isNegative() || (definition.unit === 'count' && !amount.isInteger()) ||
      (definition.targetMaximum !== undefined && amount.gt(definition.targetMaximum)))
      ctx.addIssue({ code: 'custom', path: [key], message: 'Valor fuera del dominio de la métrica' });
  }
}
export const kpiDefinitionSchema = z.object({ title, ownerId: uuid, ...periodFields, ...metricFields })
  .strict().superRefine(validPeriod).superRefine(validMetricDefinition);
export const objectiveDefinitionSchema = z.object({ title, description: z.string().trim().max(2000).default(''), ownerId: uuid, ...periodFields })
  .strict().superRefine(validPeriod);
const automaticResultSchema = z.object({ title, ownerId: uuid, kind: z.literal('automatic'), ...metricFields }).strict().superRefine(validMetricDefinition);
export const manualUnitSchema = z.enum(['count', 'percentage', 'number']);
const manualResultSchema = z.object({ title, ownerId: uuid, kind: z.literal('manual'), unit: manualUnitSchema, baseline: exactDecimalSchema, target: exactDecimalSchema })
  .strict().superRefine((value, ctx) => {
    differentTarget(value, ctx);
    for (const [key, text] of [['baseline', value.baseline], ['target', value.target]] as const) {
      if (!exactDecimalSchema.safeParse(text).success) continue;
      const amount = new Prisma.Decimal(text);
      if (value.unit !== 'number' && (amount.isNegative() || (value.unit === 'count' && !amount.isInteger())))
        ctx.addIssue({ code: 'custom', path: [key], message: 'Cantidad o porcentaje manual fuera de dominio' });
    }
  });
export const keyResultDefinitionSchema = z.discriminatedUnion('kind', [automaticResultSchema, manualResultSchema]);
export const lifecycleSchema = z.enum(['draft', 'active', 'closed', 'archived']);
export const transitionSchema = z.object({ expectedVersion: version, action: z.enum(['activate', 'close', 'archive']) }).strict();
export const manualProgressSchema = z.object({ expectedVersion: version, value: exactDecimalSchema, effectiveDate: utcDaySchema, comment: z.string().trim().min(1).max(2000) }).strict();
export const pageQuerySchema = z.preprocess(value => typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value, z.number().int().min(1).max(10000)).default(1);
export const activityQuerySchema = z.object({ from: utcDaySchema.optional(), to: utcDaySchema.optional(),
  eventType: selections(eventTypeSchema, 3), source: selections(sourceCodeSchema, 5), page: pageQuerySchema, limit: z.literal(20).default(20),
}).strict().superRefine(validPeriod);
export const measurementReasonSchema = z.enum(['NO_CUT', 'TAGS_NOT_OBSERVED', 'CREATIONS_NOT_OBSERVED', 'OUTSIDE_COVERAGE', 'ZERO_DENOMINATOR', 'WAREHOUSE_UNAVAILABLE', 'STALE_DATA', 'OUT_OF_RANGE', 'FUTURE_PERIOD']);
export const measurementSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), value: exactDecimalSchema, reason: z.null() }).strict(),
  z.object({ status: z.literal('unavailable'), value: z.null(), reason: measurementReasonSchema }).strict(),
]);
export type BiMeasurement = z.infer<typeof measurementSchema>;
export type BiKpiDefinition = z.infer<typeof kpiDefinitionSchema>;
export type BiObjectiveDefinition = z.infer<typeof objectiveDefinitionSchema>;
export type BiKeyResultDefinition = z.infer<typeof keyResultDefinitionSchema>;
