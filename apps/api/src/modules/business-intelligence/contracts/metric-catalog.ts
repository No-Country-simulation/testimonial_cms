import { z } from 'zod';

/** Semantic definitions only. No HTTP registration, SQL execution or feature activation. */
export const METRIC_CATALOG_VERSION = 'bi_metrics_v1' as const;
export const METRIC_IDS = [
  'inventory_total', 'inventory_draft', 'inventory_pending', 'inventory_approved', 'inventory_published', 'inventory_rejected',
  'average_rating', 'low_rating_share', 'published_share', 'categorized_share', 'tagged_share',
  'observed_creations', 'views', 'clicks', 'plays', 'ctr',
] as const;
export const metricIdSchema = z.enum(METRIC_IDS);
export type MetricId = z.infer<typeof metricIdSchema>;
export type MetricDimension = 'categoryId' | 'tagId' | 'status' | 'ratingMin' | 'ratingMax' | 'source';
export type MetricUnit = 'count' | 'rating' | 'percentage';
export interface MetricDefinition {
  readonly id: MetricId;
  readonly name: string;
  readonly version: typeof METRIC_CATALOG_VERSION;
  readonly owner: 'business-intelligence';
  readonly unit: MetricUnit;
  readonly temporalScope: 'closing_snapshot' | 'creation_period' | 'event_period';
  readonly aggregation: 'last_observation' | 'sum_events' | 'distinct_observed_creations' | 'recalculate_from_components';
  readonly dimensions: readonly MetricDimension[];
  readonly requires: readonly ('taxonomy' | 'creations')[];
  readonly formula: string;
  readonly lineage: readonly string[];
  readonly zeroDenominator: 'not_applicable' | 'unavailable';
  readonly favorableDirection: 'increase' | 'decrease' | 'contextual';
  readonly interpretation: string;
  readonly targetMaximum?: string;
}
const inventoryDimensions = ['categoryId', 'tagId', 'status', 'ratingMin', 'ratingMax'] as const;
const eventDimensions = [...inventoryDimensions, 'source'] as const;
const snapshotLineage = ['dw.fact_tenant_snapshot', 'dw.fact_testimonial_snapshot'] as const;
const eventLineage = ['dw.fact_engagement_daily', 'dw.dim_event_type', 'dw.dim_source'] as const;
type DefinitionInput = Omit<MetricDefinition, 'version' | 'owner'>;
const define = (input: DefinitionInput): MetricDefinition => Object.freeze({ ...input, version: METRIC_CATALOG_VERSION, owner: 'business-intelligence' });
const inventoryCount = (id: MetricId, name: string, status?: string): MetricDefinition => define({
  id, name, unit: 'count', temporalScope: 'closing_snapshot', aggregation: 'last_observation',
  dimensions: inventoryDimensions, requires: [], zeroDenominator: 'not_applicable', favorableDirection: 'contextual',
  formula: status ? `count(distinct testimonial_id) where status_code = '${status}' in filtered closing cut` : 'count(distinct testimonial_id) in filtered closing cut',
  lineage: snapshotLineage, interpretation: 'Inventario observado al cierre; no sumar cortes ni interpretarlo como flujo de moderación.',
});
const share = (id: MetricId, name: string, numerator: string, favorableDirection: MetricDefinition['favorableDirection'], taxonomy = false): MetricDefinition => define({
  id, name, unit: 'percentage', temporalScope: 'closing_snapshot', aggregation: 'recalculate_from_components',
  dimensions: inventoryDimensions, requires: taxonomy ? ['taxonomy'] : [], zeroDenominator: 'unavailable', favorableDirection,
  formula: `100 * count(distinct testimonial_id where ${numerator}) / filtered_inventory_total`,
  lineage: taxonomy ? [...snapshotLineage, 'dw.fact_tag_snapshot', 'dw.bridge_testimonial_tag_snapshot'] : [...snapshotLineage, 'dw.dim_category'],
  interpretation: 'Proporción del inventario filtrado del corte; denominador cero o corte desconocido no equivalen a 0%.', targetMaximum: '100',
});
const eventCount = (id: MetricId, name: string, code: string): MetricDefinition => define({
  id, name, unit: 'count', temporalScope: 'event_period', aggregation: 'sum_events',
  dimensions: eventDimensions, requires: [], zeroDenominator: 'not_applicable', favorableDirection: 'increase',
  formula: `sum(event_count) where event_type = '${code}' and event_date within period and selected sources`, lineage: eventLineage,
  interpretation: 'Eventos registrados, no personas únicas. Atributos del testimonio clasificados por el corte de cierre si se usan filtros de inventario.',
});

export const METRIC_CATALOG: readonly MetricDefinition[] = Object.freeze([
  inventoryCount('inventory_total', 'Testimonios'),
  inventoryCount('inventory_draft', 'Borradores', 'draft'),
  inventoryCount('inventory_pending', 'Pendientes', 'pending'),
  inventoryCount('inventory_approved', 'Aprobados', 'approved'),
  inventoryCount('inventory_published', 'Publicados', 'published'),
  inventoryCount('inventory_rejected', 'Rechazados', 'rejected'),
  define({ id: 'average_rating', name: 'Rating promedio', unit: 'rating', temporalScope: 'closing_snapshot', aggregation: 'recalculate_from_components',
    dimensions: inventoryDimensions, requires: [], zeroDenominator: 'unavailable', favorableDirection: 'increase',
    formula: 'sum(rating) / count(distinct testimonial_id) in filtered closing cut', lineage: snapshotLineage,
    interpretation: 'Media ponderada por testimonios del corte, nunca promedio de promedios diarios.', targetMaximum: '5' }),
  share('low_rating_share', 'Valoraciones bajas', 'rating between 1 and 2', 'decrease'),
  share('published_share', 'Proporción publicada', "status_code = 'published'", 'contextual'),
  share('categorized_share', 'Cobertura de categorías', 'source_category_id is not null', 'increase'),
  share('tagged_share', 'Cobertura de etiquetas', 'exists(tag in observed closing cut)', 'increase', true),
  define({ id: 'observed_creations', name: 'Creaciones observadas', unit: 'count', temporalScope: 'creation_period', aggregation: 'distinct_observed_creations',
    dimensions: inventoryDimensions, requires: ['creations'], zeroDenominator: 'not_applicable', favorableDirection: 'contextual',
    formula: 'count(distinct testimonial_id) where created_at within period and first_observed_at <= observation watermark',
    lineage: ['dw.fact_testimonial_creation', 'dw.statistics_history_state', ...snapshotLineage],
    interpretation: 'Altas que BI alcanzó a observar; no prueba todas las altas ni recupera las eliminadas entre cargas. Filtros de inventario usan el corte de cierre.' }),
  eventCount('views', 'Visualizaciones', 'view'), eventCount('clicks', 'Clics', 'click'), eventCount('plays', 'Reproducciones', 'play'),
  define({ id: 'ctr', name: 'CTR', unit: 'percentage', temporalScope: 'event_period', aggregation: 'recalculate_from_components',
    dimensions: eventDimensions, requires: [], zeroDenominator: 'unavailable', favorableDirection: 'increase',
    formula: '100 * clicks_in_filtered_period / views_in_filtered_period', lineage: eventLineage,
    interpretation: 'Cociente entre eventos; puede superar 100%. No equivale a conversión ni a visitantes únicos.' }),
]);

export function metricDefinition(id: MetricId): MetricDefinition {
  const definition = METRIC_CATALOG.find(metric => metric.id === id);
  if (!definition) throw new Error('BI_METRIC_CATALOG_INVALID');
  return definition;
}
