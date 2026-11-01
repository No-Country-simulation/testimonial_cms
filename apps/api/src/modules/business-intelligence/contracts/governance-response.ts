import {z} from 'zod';
import {exactDecimalSchema,filterScopeSchema,lifecycleSchema,measurementSchema,utcDaySchema,manualUnitSchema} from './unified-bi.contract';
import {metricIdSchema,METRIC_CATALOG_VERSION} from './metric-catalog';
const instant=z.string().datetime();
const cut=z.object({runId:z.uuid(),snapshotAt:instant,publishedAt:instant}).strict();
export const goalProvenanceSchema=z.object({observedAt:instant,closingCut:cut.nullable(),engagementReconciliation:cut.nullable(),
  tagsAtClosingCut:z.enum(['observed','not_observed']),creationHistoryStartedAt:instant.nullable(),staleAfterSeconds:z.number().nonnegative(),
  frequencyHours:z.union([z.literal(1),z.literal(6),z.literal(24)]),delayToleranceMinutes:z.union([z.literal(30),z.literal(60),z.literal(120)]),
  closingCutStale:z.boolean().nullable()}).strict();
export const goalEvaluationSchema=z.object({current:measurementSchema,progress:exactDecimalSchema.nullable(),rawProgress:exactDecimalSchema.nullable(),
  evaluatedAt:instant,provenance:goalProvenanceSchema.nullable()}).strict();
const lifecycle=z.object({id:z.uuid(),title:z.string(),ownerId:z.uuid(),from:utcDaySchema,to:utcDaySchema,state:lifecycleSchema,version:z.number().int().nonnegative(),
  activatedAt:instant.nullable(),closedAt:instant.nullable(),archivedAt:instant.nullable(),createdAt:instant,updatedAt:instant}).strict();
const metricFields={metricId:metricIdSchema,catalogVersion:z.literal(METRIC_CATALOG_VERSION),filters:filterScopeSchema};
const resultFields={id:z.uuid(),objectiveId:z.uuid(),title:z.string(),ownerId:z.uuid(),baseline:exactDecimalSchema,target:exactDecimalSchema,version:z.number().int().nonnegative(),evaluation:goalEvaluationSchema};
export const keyResultViewSchema=z.discriminatedUnion('kind',[
  z.object({...resultFields,kind:z.literal('manual'),unit:manualUnitSchema}).strict(),
  z.object({...resultFields,kind:z.literal('automatic'),...metricFields}).strict(),
]);
export const kpiViewSchema=lifecycle.extend({...metricFields,baseline:exactDecimalSchema,target:exactDecimalSchema,evaluation:goalEvaluationSchema}).strict();
export const objectiveViewSchema=lifecycle.extend({description:z.string(),keyResults:z.array(keyResultViewSchema).max(20),progress:exactDecimalSchema.nullable(),evaluationStatus:z.enum(['available','unavailable'])}).strict();
export type GoalEvaluation=z.infer<typeof goalEvaluationSchema>;
export type KpiView=z.infer<typeof kpiViewSchema>;
export type ObjectiveView=z.infer<typeof objectiveViewSchema>;
export type GovernanceView=KpiView|ObjectiveView;
