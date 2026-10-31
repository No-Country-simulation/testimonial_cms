import { Prisma } from '@prisma/client';
import { PeriodMeasurementsRepository } from '../src/modules/business-intelligence/repositories/period-measurements.repository';
import { filterScopeSchema } from '../src/modules/business-intelligence/contracts/unified-bi.contract';
const tenant='11111111-1111-4111-8111-111111111111'; const run='22222222-2222-4222-8222-222222222222';
const range={from:'2026-10-01',to:'2026-10-31',timezone:'UTC' as const};
const header={id:run,at:new Date('2026-10-31T00:00:00Z'),published:new Date('2026-10-31T00:01:00Z')};
describe('DW period measurement orchestration (SQL execution simulated)',()=>{
  const reader=new PeriodMeasurementsRepository({} as never);
  it('combines closing inventory with period events and observed creations',async()=>{
    const query=jest.fn().mockResolvedValueOnce([header]).mockResolvedValueOnce([{taxonomy:true,creations:true}]).mockResolvedValueOnce([{observed:true}])
      .mockResolvedValueOnce([{started:'2026-01-01',observedAt:new Date('2026-10-31T12:00:00Z')}])
      .mockResolvedValueOnce([{total:'2',draft:'0',pending:'0',approved:'0',published:'2',rejected:'0',ratingSum:'9',lowRating:'0',categorized:'1',tagged:'2'}])
      .mockResolvedValueOnce([{views:'10',clicks:'3',plays:'0'}]).mockResolvedValueOnce([{count:'1',initialized:true}]);
    const result=await reader.period({$queryRaw:query} as unknown as Prisma.TransactionClient,tenant,range,filterScopeSchema.parse({}));
    expect(result.metrics.average_rating).toMatchObject({value:'4.5'});expect(result.metrics.ctr).toMatchObject({value:'30'});expect(result.metrics.observed_creations).toMatchObject({value:'1'});
    expect(query).toHaveBeenCalledTimes(7);
  });
  it('does not query missing optional tables or treat a missing tag marker as an empty cohort',async()=>{
    const query=jest.fn().mockResolvedValueOnce([header]).mockResolvedValueOnce([{taxonomy:false,creations:false}])
      .mockResolvedValueOnce([{started:'2026-01-01',observedAt:new Date()}]);
    const result=await reader.period({$queryRaw:query} as unknown as Prisma.TransactionClient,tenant,range,filterScopeSchema.parse({tagId:'none'}));
    expect(result.metrics.inventory_total).toMatchObject({status:'unavailable',reason:'TAGS_NOT_OBSERVED'});expect(result.metrics.views).toMatchObject({status:'unavailable',reason:'TAGS_NOT_OBSERVED'});expect(query).toHaveBeenCalledTimes(3);
  });
  it('does not present a historical period outside observed coverage as zero',async()=>{
    const query=jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{taxonomy:false,creations:false}])
      .mockResolvedValueOnce([{started:'2026-11-01',observedAt:new Date()}]);
    const result=await reader.period({$queryRaw:query} as unknown as Prisma.TransactionClient,tenant,range,filterScopeSchema.parse({}));
    expect(result.metrics.inventory_total).toMatchObject({reason:'NO_CUT'});expect(result.metrics.views).toMatchObject({reason:'OUTSIDE_COVERAGE'});expect(query).toHaveBeenCalledTimes(3);
  });
});
