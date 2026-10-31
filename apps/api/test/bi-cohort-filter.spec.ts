import { filterScopeSchema } from '../src/modules/business-intelligence/contracts/unified-bi.contract';
import { snapshotPredicate, sourcePredicate, hasInventoryScope, previousPeriod } from '../src/modules/business-intelligence/repositories/cohort-filter';
const tenant = '11111111-1111-4111-8111-111111111111';
const run = '22222222-2222-4222-8222-222222222222';
describe('parameterized DW cohort filters', () => {
  it('always scopes inventory by tenant and exact source run', () => { const sql = snapshotPredicate(tenant,run,filterScopeSchema.parse({}),false); expect(sql.values).toEqual([tenant,run]); expect(sql.text).toContain('f.tenant_id = $1::uuid'); expect(sql.text).toContain('f.run_id = $2::uuid'); });
  it('uses semijoins for tags rather than multiplying snapshot rows', () => { const sql = snapshotPredicate(tenant,run,filterScopeSchema.parse({tagId:[tenant,run,'none']}),true); expect(sql.text).toContain('NOT EXISTS'); expect(sql.text).toContain(' OR EXISTS'); expect(sql.text).toContain('b.run_id = f.run_id'); expect(sql.text).not.toContain(tenant); expect(sql.values).toContain(tenant); });
  it('refuses to interpret unobserved taxonomy as empty taxonomy', () => { expect(()=>snapshotPredicate(tenant,run,filterScopeSchema.parse({tagId:'none'}),false)).toThrow('BI_TAGS_NOT_OBSERVED'); });
  it('separates event sources from the inventory cohort', () => { const scope=filterScopeSchema.parse({source:'widget'}); expect(snapshotPredicate(tenant,run,scope,false).values).not.toContain('widget'); expect(sourcePredicate(scope).values).toEqual(['widget']); expect(hasInventoryScope(scope)).toBe(false); });
  it('combines uncategorized and category selections with OR', () => { const sql = snapshotPredicate(tenant,run,filterScopeSchema.parse({categoryId:[tenant,'none'],ratingMin:2,ratingMax:4,status:'published'}),false); expect(sql.text).toContain('c.source_category_id IS NULL OR'); expect(sql.values).toContain('published'); expect(sql.values).toContain(2); expect(sql.values).toContain(4); });
  it('computes equal-length prior periods including leap years', () => { expect(previousPeriod({from:'2024-03-01',to:'2024-03-31'})).toEqual({from:'2024-01-30',to:'2024-02-29',timezone:'UTC'}); expect(previousPeriod({from:'0001-01-01',to:'0001-01-01'})).toBeNull(); });
});
