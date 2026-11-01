import {Injectable} from '@nestjs/common';
import {Prisma} from '@prisma/client';
import {PrismaService} from '../../database/prisma.service';
import {activityQuerySchema} from '../contracts/unified-bi.contract';
import {dateRange} from '../dtos/dashboard-query.dto';
import {safeCount} from './dashboard.repository';
import type {BiActivity} from '../contracts/unified-bi.types';
@Injectable()
export class ActivityRepository {
  constructor(private readonly prisma:PrismaService) {}
  read(tenantId:string,input:unknown,now=new Date()):Promise<BiActivity>{
    const query=activityQuerySchema.parse(input);
    const range=dateRange({...(query.from?{from:query.from}:{}),...(query.to?{to:query.to}:{})},now);
    return this.prisma.$transaction(async tx=>{
      const [clock]=await tx.$queryRaw<Array<{at:Date}>>`SELECT statement_timestamp() AS at`;
      if(!clock)throw new Error('BI_ACTIVITY_CLOCK_UNAVAILABLE');
      const source=Prisma.sql`CASE WHEN e.source IN ('public','public-browser','api','widget') THEN e.source ELSE 'other' END`;
      const joins=Prisma.sql`FROM analytics_events e JOIN testimonials t ON t.tenant_id=e.tenant_id AND t.id=e.testimonial_id
        JOIN analytics_event_types k ON k.id=e.event_type_id`;
      const where=Prisma.sql`e.tenant_id=${tenantId}::uuid AND e.created_at>=(${range.from}::date::timestamp AT TIME ZONE 'UTC')
        AND e.created_at<((${range.to}::date+1)::timestamp AT TIME ZONE 'UTC') AND e.created_at<=${clock.at}
        AND k.code IN ('view','click','play')
        AND ${query.eventType.length?Prisma.sql`k.code IN (${Prisma.join(query.eventType)})`:Prisma.sql`TRUE`}
        AND ${query.source.length?Prisma.sql`${source} IN (${Prisma.join(query.source)})`:Prisma.sql`TRUE`}`;
      const [total]=await tx.$queryRaw<Array<{count:bigint}>>(Prisma.sql`SELECT count(*) AS count ${joins} WHERE ${where}`);
      const rows=await tx.$queryRaw<Array<{id:string;createdAt:Date;eventType:'view'|'click'|'play';source:'public'|'public-browser'|'api'|'widget'|'other';testimonialId:string;authorName:string;excerpt:string}>>(Prisma.sql`
        SELECT e.id::text AS id,e.created_at AS "createdAt",k.code AS "eventType",${source} AS source,
          t.id::text AS "testimonialId",t.author_name AS "authorName",left(t.content,160) AS excerpt ${joins}
        WHERE ${where} ORDER BY e.created_at DESC,e.id DESC LIMIT 20 OFFSET ${(query.page-1)*20}`);
      return {items:rows.map(row=>({id:row.id,createdAt:row.createdAt.toISOString(),eventType:row.eventType,source:row.source,
        testimonial:{id:row.testimonialId,authorName:row.authorName,excerpt:row.excerpt}})),meta:{source:'operational',range,observedAt:clock.at.toISOString(),total:safeCount(total?.count??0n),page:query.page,limit:20}};
    },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead,timeout:10000});
  }
}
