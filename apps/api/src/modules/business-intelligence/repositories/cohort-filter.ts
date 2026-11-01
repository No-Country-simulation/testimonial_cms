import { Prisma } from '@prisma/client';
import { ApplicationError } from '../../../common/errors/application.error';
import type { BiFilterScope } from '../contracts/unified-bi.contract';

/** Fixed aliases f=DW snapshot and c=category. Values always remain parameters. */
export function snapshotPredicate(tenantId: string, runId: string | Prisma.Sql, scope: BiFilterScope, tagsObserved: boolean): Prisma.Sql {
  if (scope.tagId.length && !tagsObserved) throw new Error('BI_TAGS_NOT_OBSERVED');
  const predicates = [Prisma.sql`f.tenant_id = ${tenantId}::uuid`, Prisma.sql`f.run_id = ${runId}::uuid`];
  if (scope.categoryId.length) {
    const ids = scope.categoryId.filter(id => id !== 'none');
    const alternatives: Prisma.Sql[] = [];
    if (scope.categoryId.includes('none')) alternatives.push(Prisma.sql`c.source_category_id IS NULL`);
    if (ids.length) alternatives.push(Prisma.sql`c.source_category_id::text IN (${Prisma.join(ids)})`);
    predicates.push(Prisma.sql`(${Prisma.join(alternatives, ' OR ')})`);
  }
  if (scope.status.length) predicates.push(Prisma.sql`f.status_code IN (${Prisma.join(scope.status)})`);
  if (scope.ratingMin !== undefined) predicates.push(Prisma.sql`f.rating >= ${scope.ratingMin}`);
  if (scope.ratingMax !== undefined) predicates.push(Prisma.sql`f.rating <= ${scope.ratingMax}`);
  if (scope.tagId.length) {
    const ids = scope.tagId.filter(id => id !== 'none');
    const alternatives: Prisma.Sql[] = [];
    const membership = Prisma.sql`b.tenant_id = f.tenant_id AND b.run_id = f.run_id AND b.testimonial_id = f.testimonial_id`;
    if (scope.tagId.includes('none')) alternatives.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM dw.bridge_testimonial_tag_snapshot b WHERE ${membership})`);
    if (ids.length) alternatives.push(Prisma.sql`EXISTS (SELECT 1 FROM dw.bridge_testimonial_tag_snapshot b WHERE ${membership} AND b.tag_id::text IN (${Prisma.join(ids)}))`);
    predicates.push(Prisma.sql`(${Prisma.join(alternatives, ' OR ')})`);
  }
  return Prisma.sql`${Prisma.join(predicates, ' AND ')}`;
}
/** Source deliberately excluded from inventory predicates; applied only to events. */
export function sourcePredicate(scope: BiFilterScope): Prisma.Sql {
  return scope.source.length ? Prisma.sql`s.code IN (${Prisma.join(scope.source)})` : Prisma.sql`TRUE`;
}
export function hasInventoryScope(scope: BiFilterScope): boolean {
  return Boolean(scope.categoryId.length || scope.tagId.length || scope.status.length || scope.ratingMin !== undefined || scope.ratingMax !== undefined);
}
export function previousPeriod(range: {from: string; to: string}): {from: string; to: string; timezone: 'UTC'} | null {
  const start = Date.parse(range.from); const days = (Date.parse(range.to) - start) / 86400000 + 1;
  const previous = new Date(start - days * 86400000);
  if (previous.getUTCFullYear() < 1) return null;
  return {from: previous.toISOString().slice(0,10),to: new Date(start - 86400000).toISOString().slice(0,10), timezone:'UTC'};
}

/** Catalog membership is scoped to this tenant, never inferred from a zero metric. */
export async function assertScopeIds(tx:Prisma.TransactionClient,tenantId:string,scope:BiFilterScope,tagsAvailable:boolean):Promise<void>{
  const categories=scope.categoryId.filter(value=>value!=='none');
  const tags=scope.tagId.filter(value=>value!=='none');
  if(categories.length){
    const [row]=await tx.$queryRaw<Array<{count:bigint}>>(Prisma.sql`SELECT count(DISTINCT source_category_id) AS count FROM dw.dim_category
      WHERE tenant_id=${tenantId}::uuid AND source_category_id::text IN (${Prisma.join(categories)})`);
    if(row?.count!==BigInt(categories.length))throw new ApplicationError('Category filter is not part of this workspace','invalid_input','BI_FILTER_INVALID');
  }
  if(tags.length&&tagsAvailable){
    const [row]=await tx.$queryRaw<Array<{count:bigint}>>(Prisma.sql`SELECT count(*) AS count FROM dw.dim_tag
      WHERE tenant_id=${tenantId}::uuid AND tag_id::text IN (${Prisma.join(tags)})`);
    if(row?.count!==BigInt(tags.length))throw new ApplicationError('Tag filter is not part of this workspace','invalid_input','BI_FILTER_INVALID');
  }
}
