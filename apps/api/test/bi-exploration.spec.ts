import { Prisma } from '@prisma/client';
import { ExplorationRepository, filterOptionsQuerySchema } from '../src/modules/business-intelligence/repositories/exploration.repository';
import { PeriodMeasurementsRepository } from '../src/modules/business-intelligence/repositories/period-measurements.repository';
import { metricValues } from '../src/modules/business-intelligence/utils/measurement-engine';
const range={from:'2026-10-01',to:'2026-10-02'};
const inventory={total:'2',draft:'0',pending:'0',approved:'0',published:'2',rejected:'0',ratingSum:'9',lowRating:'0',categorized:'2',tagged:null};
const period={closingCut:{id:'22222222-2222-4222-8222-222222222222'},tagsObserved:false,coverageStartedAt:'2026-10-01',observedAt:new Date(),metrics:metricValues({inventory,engagement:{views:'0',clicks:'0',plays:'0'},creations:null})};
describe('analytical exploration orchestration (simulated SQL)',()=>{
  afterEach(()=>jest.restoreAllMocks());
  it('keeps daily inventory gaps unknown while event zeros remain observed',async()=>{
    jest.spyOn(PeriodMeasurementsRepository.prototype,'period').mockResolvedValue(period as never);
    const query=jest.fn().mockResolvedValueOnce([{taxonomy:false}]).mockResolvedValueOnce([
      {...inventory,date:'2026-10-01',at:new Date('2026-10-01Z'),tagsObserved:false},
      {...inventory,date:'2026-10-02',at:null,tagsObserved:false},
    ]).mockResolvedValueOnce([]);
    const read=jest.fn(fn=>fn({$queryRaw:query}));
    const result=await new ExplorationRepository({read} as never).daily('11111111-1111-4111-8111-111111111111',range);
    expect(result.items[0]?.metrics.average_rating).toMatchObject({value:'4.5'});
    expect(result.items[1]?.metrics.inventory_total).toMatchObject({reason:'NO_CUT'});
    expect(result.items[1]?.metrics.views).toMatchObject({value:'0'});
    expect(query).toHaveBeenCalledTimes(3);expect(read).toHaveBeenCalledTimes(1);
  });
  it('reports absent taxonomy without reading missing tables',async()=>{
    const query=jest.fn().mockResolvedValueOnce([{ready:false}]);
    const read=jest.fn(fn=>fn({$queryRaw:query}));
    const result=await new ExplorationRepository({read} as never).filterOptions('tenant',{...range,dimension:'tag'});
    expect(result.meta.availability).toBe('TAGS_NOT_OBSERVED');expect(query).toHaveBeenCalledTimes(1);
  });
  it('preserves total options on an empty page and binds literal search input',async()=>{
    const query=jest.fn((_statement:Prisma.Sql)=>Promise.resolve([{items:[],total:'21'}]));
    const read=jest.fn(fn=>fn({$queryRaw:query}));
    const result=await new ExplorationRepository({read} as never).filterOptions('tenant',{...range,dimension:'category',q:"%' OR true --",page:'3'});
    expect(result.meta.total).toBe(21);expect(query.mock.calls[0]?.[0].values).toContain("%' OR true --");
    expect(query.mock.calls[0]?.[0].text).not.toContain("%' OR true --");
  });
  it('bounds option requests and rejects tenant substitution',()=>{
    for(const input of [{dimension:'source'},{dimension:'tag',tenantId:'other'},{dimension:'tag',q:'x'.repeat(121)},{dimension:'tag',page:'0'}])
      expect(filterOptionsQuerySchema.safeParse(input).success).toBe(false);
  });
});
