import type { DateRange } from '../dtos/dashboard-query.dto';
import type { BiSettings } from '../operations.types';
import type { MetricId, METRIC_CATALOG_VERSION } from './metric-catalog';
import type { BiFilterScope, BiMeasurement, BiKeyResultDefinition, BiKpiDefinition, BiObjectiveDefinition } from './unified-bi.contract';

/** Future response data; the existing interceptor owns success/data/meta envelopes. */
export type BiMetricValues = Record<MetricId, BiMeasurement>;
export interface BiCut {
  runId: string;
  snapshotAt: string;
  publishedAt: string;
}
export interface BiProvenance {
  observedAt: string;
  closingCut: BiCut | null;
  engagementReconciliation: BiCut | null;
  tagsAtClosingCut: 'observed' | 'not_observed';
  creationHistoryStartedAt: string | null;
  staleAfterSeconds: number;
  frequencyHours: BiSettings['frequencyHours'];
  delayToleranceMinutes: BiSettings['delayToleranceMinutes'];
  closingCutStale: boolean | null;
}
export interface BiOverview {
  contractVersion: 'bi_overview_v1';
  catalogVersion: typeof METRIC_CATALOG_VERSION;
  range: DateRange;
  filters: BiFilterScope;
  provenance: BiProvenance;
  metrics: BiMetricValues;
  previous: { range: DateRange | null; provenance: BiProvenance | null; metrics: BiMetricValues };
  comparisons: Record<MetricId, { absolute: BiMeasurement; relativePercent: BiMeasurement }>;
  daily: Array<{ date: string; sourceSnapshotAt: string | null; metrics: BiMetricValues }>;
}
export interface BiInventoryBreakdown {
  id: string;
  name: string;
  count: BiMeasurement;
  averageRating: BiMeasurement;
  views: BiMeasurement;
  clicks: BiMeasurement;
  plays: BiMeasurement;
  ctr: BiMeasurement;
}
export interface BiLimitedRows<T> {
  items: T[];
  totalGroups: string;
  truncated: boolean;
}
export interface BiBreakdowns {
  contractVersion: 'bi_breakdowns_v1';
  catalogVersion: typeof METRIC_CATALOG_VERSION;
  range: DateRange;
  filters: BiFilterScope;
  provenance: BiProvenance;
  categories: BiLimitedRows<BiInventoryBreakdown>;
  tags: BiLimitedRows<BiInventoryBreakdown>;
  states: BiInventoryBreakdown[];
  ratings: BiInventoryBreakdown[];
  sources: Array<{ code: string; views: BiMeasurement; clicks: BiMeasurement; plays: BiMeasurement; ctr: BiMeasurement }>;
  ranking: BiLimitedRows<{ testimonialId: string; views: BiMeasurement; clicks: BiMeasurement; plays: BiMeasurement; ctr: BiMeasurement }>;
}
export interface BiActivity {
  /** Controller payload; the interceptor emits items as data[] and retains meta. */
  meta: {
    total: number;
    page: number;
    limit: 20;
    source: 'operational';
    range: DateRange;
    observedAt: string;
  };
  items: Array<{
    id: string;
    createdAt: string;
    eventType: 'view' | 'click' | 'play';
    source: 'public' | 'public-browser' | 'api' | 'widget' | 'other';
    testimonial: { id: string; authorName: string; excerpt: string };
  }>;
}
export interface BiGoalEvaluation {
  current: BiMeasurement;
  /** Clamped 0..100; null while the current value is unknown. */
  progress: string | null;
  /** Unclamped, for transparent over/underachievement. */
  rawProgress: string | null;
  evaluatedAt: string;
  provenance: BiProvenance | null;
}
export interface BiGoalLifecycle {
  id: string;
  state: 'draft' | 'active' | 'closed' | 'archived';
  version: number;
  activatedAt: string | null;
  closedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export type BiKpi = BiKpiDefinition & BiGoalLifecycle & { evaluation: BiGoalEvaluation };
export type BiKeyResult = BiKeyResultDefinition & {
  id: string;
  objectiveId: string;
  version: number;
  evaluation: BiGoalEvaluation;
};
export type BiObjective = BiObjectiveDefinition & BiGoalLifecycle & {
  keyResults: BiKeyResult[];
  progress: string | null;
  evaluationStatus: 'available' | 'unavailable';
};
