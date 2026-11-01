import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { BiFilterScope } from '../contracts/unified-bi.contract';
import { resolveAnalyticsQuery, pageQuerySchema } from '../contracts/unified-bi.contract';
import type { DateRange } from '../dtos/dashboard-query.dto';
import { measured, ratio, average, metricValues, compare, missing } from '../utils/measurement-engine';
import { BiConnection } from './bi-connection';
import { safeCount } from './dashboard.repository';
import { PeriodMeasurementsRepository } from './period-measurements.repository';
import { snapshotPredicate, sourcePredicate, hasInventoryScope, previousPeriod } from './cohort-filter';

export const filterOptionsQuerySchema = z.object({
  from:z.string().optional(), to:z.string().optional(), dimension:z.enum(['category','tag']),
  q:z.string().trim().max(120).default(''), page:pageQuerySchema,
}).strict();
type GroupRow={kind:string; id:string; name:string; count:string; ratingSum:string; views:string; clicks:string; plays:string; groups:string};

/** Analytical exploration only; no HTTP registration or OLTP connection. */
export class ExplorationRepository {
  private readonly periods: PeriodMeasurementsRepository;
  constructor(private readonly connection: BiConnection) { this.periods=new PeriodMeasurementsRepository(connection); }
  private cohort(tenantId:string, runId:string, scope:BiFilterScope, tagsObserved:boolean) {
    return Prisma.sql`SELECT f.testimonial_id, f.rating, f.status_code, c.source_category_id,
      coalesce(c.name,'Sin categoría') AS category_name FROM dw.fact_testimonial_snapshot f
      JOIN dw.dim_category c ON c.tenant_id=f.tenant_id AND c.category_key=f.category_key
      WHERE ${snapshotPredicate(tenantId,runId,scope,tagsObserved)}`;
  }
  breakdowns(tenantId:string, query:unknown, now=new Date()) {
    const {from,to,timezone,...scope}=resolveAnalyticsQuery(query,now);
    const range:DateRange={from,to,timezone};
    return this.connection.read(async tx=>{
      const period=await this.periods.period(tx,tenantId,range,scope);
      const canCohort=period.closingCut!==null && !(scope.tagId.length&&!period.tagsObserved);
      const empty=Prisma.sql`SELECT NULL::uuid AS testimonial_id, NULL::int AS rating, NULL::text AS status_code,
        NULL::uuid AS source_category_id, NULL::text AS category_name WHERE false`;
      const cohort=canCohort ? this.cohort(tenantId,period.closingCut!.id,scope,period.tagsObserved) : empty;
      const eventsAllowed=period.metrics.views.status==='available';
      const events=Prisma.sql`SELECT e.testimonial_id, s.code AS source,
        coalesce(sum(e.event_count) FILTER(WHERE k.code='view'),0) AS views,
        coalesce(sum(e.event_count) FILTER(WHERE k.code='click'),0) AS clicks,
        coalesce(sum(e.event_count) FILTER(WHERE k.code='play'),0) AS plays
        FROM dw.fact_engagement_daily e JOIN dw.dim_source s ON s.tenant_id=e.tenant_id AND s.source_key=e.source_key
        JOIN dw.dim_event_type k ON k.event_type_key=e.event_type_key
        WHERE e.tenant_id=${tenantId}::uuid AND e.date_key BETWEEN ${from}::date AND ${to}::date
          AND ${eventsAllowed} AND ${sourcePredicate(scope)}
          AND ${hasInventoryScope(scope)?Prisma.sql`EXISTS(SELECT 1 FROM cohort f WHERE f.testimonial_id=e.testimonial_id)`:Prisma.sql`TRUE`}
        GROUP BY e.testimonial_id,s.code`;
      const tags=period.tagsObserved ? Prisma.sql`UNION ALL SELECT 'tag', b.tag_id::text, t.name, f.* FROM cohort f
        JOIN dw.bridge_testimonial_tag_snapshot b ON b.tenant_id=${tenantId}::uuid AND b.run_id=${period.closingCut!.id}::uuid AND b.testimonial_id=f.testimonial_id
        JOIN dw.dim_tag t ON t.tenant_id=b.tenant_id AND t.tag_id=b.tag_id` : Prisma.empty;
      const rows=await tx.$queryRaw<GroupRow[]>(Prisma.sql`WITH cohort AS (${cohort}), events AS (${events}),
        totals AS (SELECT testimonial_id,sum(views) AS views,sum(clicks) AS clicks,sum(plays) AS plays FROM events GROUP BY testimonial_id),
        memberships AS (
          SELECT 'category' AS kind,coalesce(source_category_id::text,'none') AS id,category_name AS name,f.* FROM cohort f
          UNION ALL SELECT 'state',status_code,status_code,f.* FROM cohort f
          UNION ALL SELECT 'rating',rating::text,rating::text,f.* FROM cohort f ${tags}),
        grouped AS (SELECT kind,id,name,count(*) AS n,sum(rating) AS rating_sum,
          coalesce(sum(e.views),0) AS views,coalesce(sum(e.clicks),0) AS clicks,coalesce(sum(e.plays),0) AS plays
          FROM memberships m LEFT JOIN totals e USING(testimonial_id) GROUP BY kind,id,name),
        ranked AS (SELECT *,count(*) OVER(PARTITION BY kind) AS groups,row_number() OVER(PARTITION BY kind ORDER BY n DESC,id) AS pos FROM grouped)
        SELECT kind,id,name,n::text AS count,rating_sum::text AS "ratingSum",views::text,clicks::text,plays::text,groups::text
        FROM ranked WHERE pos<=50 ORDER BY kind,pos`);
      const groups=new Map<string,GroupRow[]>();
      for(const row of rows) groups.set(row.kind,[...(groups.get(row.kind)??[]),row]);
      const list=(kind:string)=>{
        const selected=groups.get(kind)??[];
        return {items:selected.map(row=>({id:row.id,name:row.name,count:measured(row.count),
          averageRating:average(row.ratingSum,row.count),
          views:eventsAllowed?measured(row.views):period.metrics.views,clicks:eventsAllowed?measured(row.clicks):period.metrics.clicks,
          plays:eventsAllowed?measured(row.plays):period.metrics.plays,ctr:eventsAllowed?ratio(row.clicks,row.views):period.metrics.ctr})),
          totalGroups:selected[0]?.groups??'0',truncated:BigInt(selected[0]?.groups??'0')>BigInt(selected.length)};
      };
      const sources=await tx.$queryRaw<Array<{code:string;views:string;clicks:string;plays:string}>>(Prisma.sql`WITH cohort AS (${cohort}),events AS (${events})
        SELECT source AS code,sum(views)::text AS views,sum(clicks)::text AS clicks,sum(plays)::text AS plays FROM events GROUP BY source ORDER BY source`);
      const ranking=await tx.$queryRaw<Array<{testimonialId:string;views:string;clicks:string;plays:string;groups:string}>>(Prisma.sql`WITH cohort AS (${cohort}),events AS (${events}),
        grouped AS(SELECT testimonial_id,sum(views) AS views,sum(clicks) AS clicks,sum(plays) AS plays FROM events GROUP BY testimonial_id)
        SELECT testimonial_id::text AS "testimonialId",views::text,clicks::text,plays::text,count(*) OVER()::text AS groups
        FROM grouped ORDER BY views DESC,testimonial_id LIMIT 20`);
      return {range,filters:scope,period,categories:list('category'),tags:list('tag'),states:list('state').items,ratings:list('rating').items,
        tagsAvailability:period.tagsObserved?'available':'TAGS_NOT_OBSERVED',
        sources:sources.map(row=>({code:row.code,views:measured(row.views),clicks:measured(row.clicks),plays:measured(row.plays),ctr:ratio(row.clicks,row.views)})),
        ranking:{items:ranking.map(row=>({testimonialId:row.testimonialId,views:measured(row.views),clicks:measured(row.clicks),plays:measured(row.plays),ctr:ratio(row.clicks,row.views)})),totalGroups:ranking[0]?.groups??'0',truncated:BigInt(ranking[0]?.groups??'0')>BigInt(ranking.length)}};
    });
  }
  daily(tenantId:string,query:unknown,now=new Date()){return this.connection.read(tx=>this.dailyIn(tx,tenantId,query,now));}
  private async dailyIn(tx:Prisma.TransactionClient,tenantId:string,query:unknown,now:Date){
    const {from,to,timezone,...scope}=resolveAnalyticsQuery(query,now);
      const period=await this.periods.period(tx,tenantId,{from,to,timezone},scope);
      const [cap]=await tx.$queryRaw<Array<{taxonomy:boolean}>>`SELECT to_regclass('dw.fact_tag_snapshot') IS NOT NULL AS taxonomy`;
      const tagged=cap?.taxonomy?Prisma.sql`EXISTS(SELECT 1 FROM dw.bridge_testimonial_tag_snapshot b WHERE b.tenant_id=f.tenant_id AND b.run_id=f.run_id AND b.testimonial_id=f.testimonial_id)`:Prisma.sql`false`;
      const observed=cap?.taxonomy?Prisma.sql`EXISTS(SELECT 1 FROM dw.fact_tag_snapshot m WHERE m.tenant_id=${tenantId}::uuid AND m.run_id=h.run_id)`:Prisma.sql`false`;
      const predicate=snapshotPredicate(tenantId,Prisma.sql`h.run_id`,scope,true);
      // Omitted tag storage is never referenced on legacy warehouses.
      const safePredicate=scope.tagId.length&&!cap?.taxonomy?Prisma.sql`false`:predicate;
      const rows=await tx.$queryRaw<Array<NonNullable<import('../utils/measurement-engine').MetricInputs['inventory']>&{date:string;at:Date|null;tagsObserved:boolean}>>(Prisma.sql`
        WITH days AS(SELECT generate_series(${from}::date,${to}::date,interval '1 day')::date AS day)
        SELECT d.day::text AS date,h.snapshot_at AS at,${observed} AS "tagsObserved",a.* FROM days d
        LEFT JOIN LATERAL(SELECT run_id,snapshot_at FROM dw.fact_tenant_snapshot WHERE tenant_id=${tenantId}::uuid
          AND snapshot_date_key=d.day ORDER BY snapshot_at DESC,run_id LIMIT 1) h ON true
        CROSS JOIN LATERAL(SELECT count(*)::text AS total,count(*) FILTER(WHERE status_code='draft')::text AS draft,
          count(*) FILTER(WHERE status_code='pending')::text AS pending,count(*) FILTER(WHERE status_code='approved')::text AS approved,
          count(*) FILTER(WHERE status_code='published')::text AS published,count(*) FILTER(WHERE status_code='rejected')::text AS rejected,
          coalesce(sum(rating),0)::text AS "ratingSum",count(*) FILTER(WHERE rating<=2)::text AS "lowRating",
          count(*) FILTER(WHERE c.source_category_id IS NOT NULL)::text AS categorized,
          count(*) FILTER(WHERE ${tagged})::text AS tagged
          FROM dw.fact_testimonial_snapshot f JOIN dw.dim_category c ON c.tenant_id=f.tenant_id AND c.category_key=f.category_key
          WHERE ${safePredicate}) a ORDER BY d.day`);
      const cohortRequired=hasInventoryScope(scope);
      const canCohort=period.closingCut!==null&&!(scope.tagId.length&&!period.tagsObserved);
      const cohort=canCohort?this.cohort(tenantId,period.closingCut!.id,scope,period.tagsObserved):Prisma.sql`SELECT NULL::uuid AS testimonial_id WHERE false`;
      const events=await tx.$queryRaw<Array<{date:string;views:string;clicks:string;plays:string}>>(Prisma.sql`WITH cohort AS(${cohort})
        SELECT e.date_key::text AS date,coalesce(sum(e.event_count) FILTER(WHERE k.code='view'),0)::text AS views,
          coalesce(sum(e.event_count) FILTER(WHERE k.code='click'),0)::text AS clicks,coalesce(sum(e.event_count) FILTER(WHERE k.code='play'),0)::text AS plays
        FROM dw.fact_engagement_daily e JOIN dw.dim_event_type k ON k.event_type_key=e.event_type_key
        JOIN dw.dim_source s ON s.tenant_id=e.tenant_id AND s.source_key=e.source_key
        WHERE e.tenant_id=${tenantId}::uuid AND e.date_key BETWEEN ${from}::date AND ${to}::date AND ${sourcePredicate(scope)}
        AND ${cohortRequired?Prisma.sql`EXISTS(SELECT 1 FROM cohort f WHERE f.testimonial_id=e.testimonial_id)`:Prisma.sql`TRUE`} GROUP BY e.date_key`);
      const byDay=new Map(events.map(row=>[row.date,row]));
      const creations=new Map<string,string>();
      if(period.metrics.observed_creations.status==='available') {
        const created=await tx.$queryRaw<Array<{date:string;count:string}>>(Prisma.sql`WITH cohort AS(${cohort})
          SELECT (n.created_at AT TIME ZONE 'UTC')::date::text AS date,count(*)::text AS count FROM dw.fact_testimonial_creation n
          WHERE n.tenant_id=${tenantId}::uuid AND n.created_at>=(${from}::date::timestamp AT TIME ZONE 'UTC')
          AND n.created_at<((${to}::date+1)::timestamp AT TIME ZONE 'UTC') AND n.first_observed_at<=${period.observedAt}
          AND ${cohortRequired?Prisma.sql`EXISTS(SELECT 1 FROM cohort f WHERE f.testimonial_id=n.testimonial_id)`:Prisma.sql`TRUE`}
          GROUP BY (n.created_at AT TIME ZONE 'UTC')::date`);
        for(const row of created) creations.set(row.date,row.count);
      }
      return {period,range:{from,to,timezone},filters:scope,items:rows.map(row=>{
        const tagsMissing=scope.tagId.length>0&&!row.tagsObserved;
        const covered=period.coverageStartedAt!==null&&row.date>=period.coverageStartedAt;
        return {date:row.date,sourceSnapshotAt:row.at?.toISOString()??null,metrics:metricValues({
          inventory:row.at&&!tagsMissing?{...row,tagged:row.tagsObserved?row.tagged:null}:null,
          inventoryReason:tagsMissing?'TAGS_NOT_OBSERVED':'NO_CUT',
          engagement:covered&&(!cohortRequired||canCohort)?byDay.get(row.date)??{views:'0',clicks:'0',plays:'0'}:null,
          engagementReason:scope.tagId.length&&!period.tagsObserved?'TAGS_NOT_OBSERVED':cohortRequired&&!canCohort?'NO_CUT':'OUTSIDE_COVERAGE',
          creations:period.metrics.observed_creations.status==='available'?creations.get(row.date)??'0':null,
          creationsReason:period.metrics.observed_creations.status==='unavailable'?period.metrics.observed_creations.reason:'CREATIONS_NOT_OBSERVED',
        })};
      })};
  }
  overview(tenantId:string,query:unknown,now=new Date()) {
    return this.connection.read(async tx=>{
      const current=await this.dailyIn(tx,tenantId,query,now);
      const previousRange=previousPeriod(current.range);
      const previous=previousRange?await this.periods.period(tx,tenantId,previousRange,current.filters):null;
      const prior=new Map(Object.entries(previous?.metrics??{}));
      const comparisons=Object.fromEntries(Object.entries(current.period.metrics).map(([key,value])=>[key,compare(value,prior.get(key)??missing('OUTSIDE_COVERAGE'))]));
      return {...current,previousRange,previous,comparisons};
    });
  }
  filterOptions(tenantId:string, query:unknown, now=new Date()) {
    const input=filterOptionsQuerySchema.parse(query);
    const {from,to}=resolveAnalyticsQuery({...(input.from?{from:input.from}:{}),...(input.to?{to:input.to}:{})},now);
    return this.connection.read(async tx=>{
      if(input.dimension==='tag') {
        const [capability]=await tx.$queryRaw<Array<{ready:boolean}>>`SELECT to_regclass('dw.fact_tag_snapshot') IS NOT NULL AS ready`;
        if(!capability?.ready) return {items:[],meta:{page:input.page,limit:20,total:0,availability:'TAGS_NOT_OBSERVED'}};
      }
      if(input.dimension==='tag') {
        const [marker]=await tx.$queryRaw<Array<{observed:boolean}>>`SELECT EXISTS(SELECT 1 FROM dw.fact_tag_snapshot m
          JOIN dw.fact_tenant_snapshot h ON h.tenant_id=m.tenant_id AND h.run_id=m.run_id
          WHERE m.tenant_id=${tenantId}::uuid AND h.snapshot_at<((${to}::date+1)::timestamp AT TIME ZONE 'UTC')) AS observed`;
        if(!marker?.observed) return {items:[],meta:{page:input.page,limit:20,total:0,availability:'TAGS_NOT_OBSERVED',from,to}};
      }
      const relation=input.dimension==='category'?Prisma.sql`SELECT coalesce(c.source_category_id::text,'none') AS id,c.name FROM dw.fact_testimonial_snapshot f
        JOIN dw.fact_tenant_snapshot h ON h.tenant_id=f.tenant_id AND h.run_id=f.run_id
        JOIN dw.dim_category c ON c.tenant_id=f.tenant_id AND c.category_key=f.category_key
        WHERE f.tenant_id=${tenantId}::uuid AND h.snapshot_at < ((${to}::date+1)::timestamp AT TIME ZONE 'UTC')`
        :Prisma.sql`SELECT t.tag_id::text AS id,t.name FROM dw.bridge_testimonial_tag_snapshot b
          JOIN dw.fact_tenant_snapshot h ON h.tenant_id=b.tenant_id AND h.run_id=b.run_id
          JOIN dw.dim_tag t ON t.tenant_id=b.tenant_id AND t.tag_id=b.tag_id
          WHERE b.tenant_id=${tenantId}::uuid AND h.snapshot_at < ((${to}::date+1)::timestamp AT TIME ZONE 'UTC')`;
      // Literal substring matching: wildcard characters in q are not SQL patterns.
      const [result]=await tx.$queryRaw<Array<{items:Array<{id:string;name:string}>;total:string}>>(Prisma.sql`WITH options AS(SELECT DISTINCT id,name FROM (${relation}) observed),
        selected AS(SELECT id,name FROM options WHERE strpos(lower(name),lower(${input.q}))>0),
        page AS(SELECT id,name FROM selected ORDER BY name,id LIMIT 20 OFFSET ${(input.page-1)*20})
        SELECT coalesce((SELECT jsonb_agg(page ORDER BY name,id) FROM page),'[]'::jsonb) AS items,(SELECT count(*)::text FROM selected) AS total`);
      return {items:result?.items??[],meta:{page:input.page,limit:20,total:safeCount(BigInt(result?.total??'0')),availability:'available',from,to}};
    });
  }
}
