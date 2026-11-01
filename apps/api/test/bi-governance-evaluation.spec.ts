import {Prisma} from '@prisma/client';
import {GovernanceEvaluationService} from '../src/modules/business-intelligence/services/governance-evaluation.service';
import {ApplicationError} from '../src/common/errors/application.error';
import {metricValues} from '../src/modules/business-intelligence/utils/measurement-engine';
const id='11111111-1111-4111-8111-111111111111';const second='22222222-2222-4222-8222-222222222222';const resultId='33333333-3333-4333-8333-333333333333';
const now=new Date('2026-11-01T12:00:00Z');
const actor={userId:id,tenantId:id,roles:['admin' as const],isActive:true,email:'synthetic@example.test',tenantName:'Synthetic'};
const common={id,tenantId:id,title:'Synthetic',ownerId:id,periodFrom:new Date('2026-11-01Z'),periodTo:new Date('2026-11-30Z'),state:'active',version:1,
  activatedAt:now,closedAt:null,archivedAt:null,closingEvaluation:null,createdAt:now,updatedAt:now};
const metric={metricId:'views',catalogVersion:'bi_metrics_v1',filters:{},baseline:new Prisma.Decimal(0),target:new Prisma.Decimal(100)};
const kpi={...common,...metric};
const automatic={id:resultId,objectiveId:id,tenantId:id,title:'Automatic',ownerId:id,kind:'automatic',...metric,manualUnit:null,version:0,createdAt:now,updatedAt:now};
const manual={...automatic,id:second,kind:'manual',metricId:null,catalogVersion:null,filters:null,manualUnit:'count'};
const metrics=metricValues({inventory:null,engagement:{views:'50',clicks:'10',plays:'0'},creations:null});
const period={metrics,closingCut:{id,at:new Date('2026-11-01T11:30:00Z'),published:now},observedAt:now,tagsObserved:true,coverageStartedAt:'2026-10-01',reconciliation:{id,at:'2026-11-01T11:30:00Z',published:now.toISOString()},creationHistoryStartedAt:now};
describe('governance presentation and independent DW availability',()=>{
  const goals={readSnapshot:jest.fn()};const periods={batch:jest.fn()};const operations={settings:jest.fn()};
  const service=new GovernanceEvaluationService(goals as never,periods as never,operations as never);
  beforeEach(()=>{jest.resetAllMocks();goals.readSnapshot.mockResolvedValue({items:[kpi],observations:[],meta:{page:1,limit:20,total:1}});
    operations.settings.mockResolvedValue({frequencyHours:1,delayToleranceMinutes:60});
    periods.batch.mockImplementation(async(_tenant,requests)=>new Map(requests.map((request:{key:string})=>[request.key,period])));
  });
  it('groups identical persisted scopes and returns numeric values as exact strings',async()=>{
    goals.readSnapshot.mockResolvedValue({items:[kpi,{...kpi,id:second}],observations:[],meta:{page:1,limit:20,total:2}});
    const result=await service.read(actor,'kpi',{},undefined,now);
    expect(periods.batch.mock.calls[0]?.[1]).toHaveLength(1);
    expect(result.items[0]).toMatchObject({baseline:'0',target:'100',evaluation:{current:{value:'50'},progress:'50'}});
  });
  it('keeps manual values and definitions when DW is unavailable; aggregate stays unknown',async()=>{
    goals.readSnapshot.mockResolvedValue({items:[{...common,description:'',keyResults:[automatic,manual]}],observations:[{id:second,value:'25'}],meta:{page:1,limit:20,total:1}});
    periods.batch.mockRejectedValue(new ApplicationError('Unavailable','unavailable','BI_UNAVAILABLE'));
    const result=await service.detail(actor,'objective',id,now);
    expect(result).toMatchObject({progress:null,evaluationStatus:'unavailable',keyResults:[{evaluation:{current:{reason:'WAREHOUSE_UNAVAILABLE'}}},{evaluation:{current:{value:'25'},progress:'25'}}]});
  });
  it('does not calculate before a persisted period starts',async()=>{
    goals.readSnapshot.mockResolvedValue({items:[{...kpi,periodFrom:new Date('2026-11-02Z')}],observations:[],meta:{page:1,limit:20,total:1}});
    expect(await service.detail(actor,'kpi',id,now)).toMatchObject({evaluation:{current:{reason:'FUTURE_PERIOD'},progress:null}});
    expect(periods.batch).not.toHaveBeenCalled();expect(operations.settings).not.toHaveBeenCalled();
  });
  it('withholds a stale automatic value',async()=>{
    periods.batch.mockImplementation(async(_tenant,requests)=>new Map(requests.map((request:{key:string})=>[request.key,{...period,reconciliation:{...period.reconciliation,at:'2026-10-30T00:00:00Z'}}])));
    expect(await service.detail(actor,'kpi',id,now)).toMatchObject({evaluation:{current:{reason:'STALE_DATA'},progress:null}});
  });
  it('freezes saved closed evaluations and bypasses DW entirely',async()=>{
    const saved=await service.detail(actor,'kpi',id,now);periods.batch.mockClear();operations.settings.mockClear();
    goals.readSnapshot.mockResolvedValue({items:[{...kpi,state:'archived',version:3,closedAt:now,archivedAt:now,closingEvaluation:{evaluation:saved}}],observations:[],meta:{page:1,limit:20,total:1}});
    expect(await service.detail(actor,'kpi',id,new Date('2026-11-05Z'))).toMatchObject({state:'archived',version:3,evaluation:{current:{value:'50'},evaluatedAt:now.toISOString()}});
    expect(periods.batch).not.toHaveBeenCalled();expect(operations.settings).not.toHaveBeenCalled();
  });
  it('captures only the matching reviewed version and rejects corrupted persisted catalogs',async()=>{
    await expect(service.capture(actor,'kpi',id,0,now)).rejects.toMatchObject({code:'BI_GOAL_VERSION_CONFLICT'});
    expect(await service.capture(actor,'kpi',id,1,now)).toMatchObject({resourceId:id,resourceVersion:1,results:[]});
    goals.readSnapshot.mockResolvedValue({items:[{...kpi,catalogVersion:'unsupported'}],observations:[],meta:{page:1,limit:20,total:1}});
    await expect(service.detail(actor,'kpi',id,now)).rejects.toMatchObject({code:'BI_GOAL_DATA_INVALID'});
  });
});
