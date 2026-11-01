import { Prisma } from '@prisma/client';
import { ApplicationError } from '../../../common/errors/application.error';
import type { DateRange } from '../dtos/dashboard-query.dto';
import type { BiFilterScope } from '../contracts/unified-bi.contract';
import { resolveAnalyticsQuery } from '../contracts/unified-bi.contract';
import { compare, metricValues, type MetricInputs } from '../utils/measurement-engine';
import { BiConnection } from './bi-connection';
import { snapshotPredicate, sourcePredicate, hasInventoryScope, previousPeriod, assertScopeIds } from './cohort-filter';

type Header = { id: string; at: Date; published: Date };
export class PeriodMeasurementsRepository {
  constructor(private readonly connection: BiConnection) {}
  read(tenantId: string, query: unknown, now = new Date()) {
    const scope = resolveAnalyticsQuery(query, now);
    const range: DateRange = {from: scope.from, to: scope.to, timezone:'UTC'};
    const before = previousPeriod(range);
    const {from: _from, to: _to, timezone: _timezone, ...filters} = scope;
    return this.connection.read(async tx => {
      const current = await this.period(tx,tenantId,range,filters);
      const previous = before ? await this.period(tx,tenantId,before,filters) : null;
      const previousValues = new Map(Object.entries(previous?.metrics ?? {}));
      const comparisons = Object.fromEntries(Object.entries(current.metrics).map(([id, measurement]) => [id, compare(measurement, previousValues.get(id) ?? {status:'unavailable',value:null,reason:'OUTSIDE_COVERAGE'})]));
      return {range, filters, current, previous, comparisons};
    });
  }
  validateScope(tenantId:string,scope:BiFilterScope){
    const categoryIds=scope.categoryId.filter(value=>value!=='none');const tagIds=scope.tagId.filter(value=>value!=='none');
    if(!categoryIds.length&&!tagIds.length)return Promise.resolve();
    return this.connection.read(async tx=>{
      let tagsReady=false;
      if(tagIds.length){
        const [cap]=await tx.$queryRaw<Array<{ready:boolean}>>`SELECT to_regclass('dw.dim_tag') IS NOT NULL AS ready`;
        tagsReady=cap?.ready===true;
        if(!tagsReady)throw new ApplicationError('Taxonomy unavailable for validating a new scope','unavailable','BI_STATISTICS_UNAVAILABLE');
      }
      await assertScopeIds(tx,tenantId,scope,tagsReady);
    });
  }
  batch(tenantId:string, requests:Array<{key:string;query:unknown}>,now=new Date()) {
    const queries=requests.map(request=>({key:request.key,scope:resolveAnalyticsQuery(request.query,now)}));
    if(!queries.length)return Promise.resolve(new Map<string,Awaited<ReturnType<PeriodMeasurementsRepository['period']>>>());
    return this.connection.read(async tx=>{
      const results=new Map<string,Awaited<ReturnType<PeriodMeasurementsRepository['period']>>>();
      for(const request of queries){
        const {from,to,timezone,...filters}=request.scope;
        results.set(request.key,await this.period(tx,tenantId,{from,to,timezone},filters));
      }
      return results;
    });
  }
  async period(tx: Prisma.TransactionClient, tenantId: string, range: DateRange, scope: BiFilterScope) {
    const [header] = await tx.$queryRaw<Header[]>`SELECT run_id AS id, snapshot_at AS at, published_at AS published
      FROM dw.fact_tenant_snapshot WHERE tenant_id=${tenantId}::uuid
      AND snapshot_at < ((${range.to}::date + 1)::timestamp AT TIME ZONE 'UTC') ORDER BY snapshot_at DESC, run_id LIMIT 1`;
    const [availability] = await tx.$queryRaw<Array<{taxonomy:boolean; creations:boolean}>>`SELECT
      to_regclass('dw.fact_tag_snapshot') IS NOT NULL AND to_regclass('dw.bridge_testimonial_tag_snapshot') IS NOT NULL AS taxonomy,
      to_regclass('dw.fact_testimonial_creation') IS NOT NULL AND to_regclass('dw.statistics_history_state') IS NOT NULL AS creations`;
    let tagsObserved = false;
    if (header && availability?.taxonomy) {
      const [marker] = await tx.$queryRaw<Array<{observed:boolean}>>`SELECT EXISTS(SELECT 1 FROM dw.fact_tag_snapshot WHERE tenant_id=${tenantId}::uuid AND run_id=${header.id}::uuid) AS observed`;
      tagsObserved = marker?.observed === true;
    }
    if(header)await assertScopeIds(tx,tenantId,scope,tagsObserved);
    const creationHistory=availability?.creations?Prisma.sql`(SELECT min(first_observed_at) FROM dw.fact_testimonial_creation WHERE tenant_id=${tenantId}::uuid)`:Prisma.sql`NULL::timestamptz`;
    const [history] = await tx.$queryRaw<Array<{started:string|null; observedAt:Date; reconciliation:{id:string;at:string;published:string}|null; creationStarted:Date|null}>>(Prisma.sql`SELECT
      (SELECT least(min(snapshot_at)::date, (SELECT min(date_key) FROM dw.fact_engagement_daily WHERE tenant_id=${tenantId}::uuid))::text
       FROM dw.fact_tenant_snapshot WHERE tenant_id=${tenantId}::uuid) AS started, statement_timestamp() AS "observedAt",
      (SELECT jsonb_build_object('id',run_id,'at',snapshot_at,'published',published_at) FROM dw.fact_tenant_snapshot
        WHERE tenant_id=${tenantId}::uuid ORDER BY snapshot_at DESC,run_id LIMIT 1) AS reconciliation,
      ${creationHistory} AS "creationStarted"`);
    const missingTags = scope.tagId.length > 0 && !tagsObserved;
    const canCohort = Boolean(header) && !missingTags;
    const cohort = canCohort ? Prisma.sql`SELECT f.testimonial_id, f.status_code, f.rating, c.source_category_id
      FROM dw.fact_testimonial_snapshot f JOIN dw.dim_category c ON c.tenant_id=f.tenant_id AND c.category_key=f.category_key
      WHERE ${snapshotPredicate(tenantId,header!.id,scope,tagsObserved)}` : Prisma.sql`SELECT NULL::uuid AS testimonial_id, NULL::text AS status_code, NULL::int AS rating, NULL::uuid AS source_category_id WHERE false`;
    let inventory: MetricInputs['inventory'] = null;
    if (canCohort) {
      const tagged = tagsObserved ? Prisma.sql`(SELECT count(*)::text FROM cohort f WHERE EXISTS(SELECT 1 FROM dw.bridge_testimonial_tag_snapshot b
        WHERE b.tenant_id=${tenantId}::uuid AND b.run_id=${header!.id}::uuid AND b.testimonial_id=f.testimonial_id))` : Prisma.sql`NULL::text`;
      const [row] = await tx.$queryRaw<NonNullable<MetricInputs['inventory']>[]>(Prisma.sql`WITH cohort AS (${cohort}) SELECT count(*)::text AS total,
        count(*) FILTER(WHERE status_code='draft')::text AS draft, count(*) FILTER(WHERE status_code='pending')::text AS pending,
        count(*) FILTER(WHERE status_code='approved')::text AS approved, count(*) FILTER(WHERE status_code='published')::text AS published,
        count(*) FILTER(WHERE status_code='rejected')::text AS rejected, coalesce(sum(rating),0)::text AS "ratingSum",
        count(*) FILTER(WHERE rating<=2)::text AS "lowRating", count(*) FILTER(WHERE source_category_id IS NOT NULL)::text AS categorized,
        ${tagged} AS tagged FROM cohort`);
      inventory = row ?? null;
    }
    const covered = Boolean(history?.started && range.from >= history.started);
    const cohortRequired = hasInventoryScope(scope);
    let engagement: MetricInputs['engagement'] = null;
    if (covered && (!cohortRequired || canCohort)) {
      const [events] = await tx.$queryRaw<NonNullable<MetricInputs['engagement']>[]>(Prisma.sql`WITH cohort AS (${cohort}) SELECT
        coalesce(sum(e.event_count) FILTER(WHERE k.code='view'),0)::text AS views,
        coalesce(sum(e.event_count) FILTER(WHERE k.code='click'),0)::text AS clicks,
        coalesce(sum(e.event_count) FILTER(WHERE k.code='play'),0)::text AS plays
        FROM dw.fact_engagement_daily e JOIN dw.dim_event_type k ON k.event_type_key=e.event_type_key
        JOIN dw.dim_source s ON s.tenant_id=e.tenant_id AND s.source_key=e.source_key
        WHERE e.tenant_id=${tenantId}::uuid AND e.date_key BETWEEN ${range.from}::date AND ${range.to}::date AND ${sourcePredicate(scope)}
        AND ${cohortRequired ? Prisma.sql`EXISTS(SELECT 1 FROM cohort f WHERE f.testimonial_id=e.testimonial_id)` : Prisma.sql`TRUE`}`);
      engagement = events ?? null;
    }
    let creations: string|null = null;
    if (availability?.creations && covered && (!cohortRequired || canCohort)) {
      const [value] = await tx.$queryRaw<Array<{count:string; initialized:boolean}>>(Prisma.sql`WITH cohort AS (${cohort}) SELECT
        (SELECT count(*)::text FROM dw.fact_testimonial_creation n WHERE n.tenant_id=${tenantId}::uuid
          AND n.created_at >= (${range.from}::date::timestamp AT TIME ZONE 'UTC')
          AND n.created_at < ((${range.to}::date+1)::timestamp AT TIME ZONE 'UTC')
          AND n.first_observed_at <= ${history!.observedAt}
          AND ${cohortRequired ? Prisma.sql`EXISTS(SELECT 1 FROM cohort f WHERE f.testimonial_id=n.testimonial_id)` : Prisma.sql`TRUE`}) AS count,
        EXISTS(SELECT 1 FROM dw.statistics_history_state x WHERE x.tenant_id=${tenantId}::uuid AND x.creations_through_run_id=
          (SELECT run_id FROM dw.fact_tenant_snapshot WHERE tenant_id=${tenantId}::uuid ORDER BY snapshot_at DESC,run_id LIMIT 1)) AS initialized`);
      if (value?.initialized) creations=value.count;
    }
    const metrics = metricValues({inventory,engagement,creations,inventoryReason:missingTags?'TAGS_NOT_OBSERVED':'NO_CUT',
      engagementReason:missingTags?'TAGS_NOT_OBSERVED':cohortRequired&&!header?'NO_CUT':'OUTSIDE_COVERAGE',
      creationsReason:missingTags?'TAGS_NOT_OBSERVED':!covered?'OUTSIDE_COVERAGE':'CREATIONS_NOT_OBSERVED'});
    return {metrics, closingCut:header??null, tagsObserved, observedAt:history?.observedAt??null, coverageStartedAt:history?.started??null, reconciliation:history?.reconciliation??null, creationHistoryStartedAt:history?.creationStarted??null};
  }
}
