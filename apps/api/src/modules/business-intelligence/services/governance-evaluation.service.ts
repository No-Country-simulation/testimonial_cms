import {Injectable} from '@nestjs/common';
import {z} from 'zod';
import {ApplicationError} from '../../../common/errors/application.error';
import type {AuthenticatedUser} from '../../../common/interfaces/auth-context.interface';
import {GovernanceRepository,type GovernanceGoalRow,type GovernanceObjectiveRow} from '../repositories/governance.repository';
import {PeriodMeasurementsRepository} from '../repositories/period-measurements.repository';
import {OperationsReadRepository} from '../repositories/operations-read.repository';
import {filterScopeSchema} from '../contracts/unified-bi.contract';
import {metricIdSchema,metricDefinition,METRIC_CATALOG_VERSION} from '../contracts/metric-catalog';
import {goalEvaluationSchema,kpiViewSchema,objectiveViewSchema,type GoalEvaluation,type GovernanceView} from '../contracts/governance-response';
import type {GovernanceCapture} from '../utils/governance-policy';
import {requireBiAdmin,requireVersion} from '../utils/governance-policy';
import {measured,missing,progress,objectiveProgress} from '../utils/measurement-engine';
import {hasInventoryScope} from '../repositories/cohort-filter';

type Period=Awaited<ReturnType<PeriodMeasurementsRepository['period']>>;
type ResultRow=GovernanceObjectiveRow['keyResults'][number];
const day=(value:Date)=>value.toISOString().slice(0,10);
const instant=(value:Date|null)=>value?.toISOString()??null;
const invalid=()=>new ApplicationError('Stored BI governance data is incompatible','unavailable','BI_GOAL_DATA_INVALID');
function output<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);if(!result.success)throw invalid();return result.data;}
function base(row:GovernanceGoalRow){return {id:row.id,title:row.title,ownerId:row.ownerId,from:day(row.periodFrom),to:day(row.periodTo),state:row.state,version:row.version,
  activatedAt:instant(row.activatedAt),closedAt:instant(row.closedAt),archivedAt:instant(row.archivedAt),createdAt:row.createdAt.toISOString(),updatedAt:row.updatedAt.toISOString()};}
@Injectable()
export class GovernanceEvaluationService {
  constructor(private readonly goals:GovernanceRepository,private readonly periods:PeriodMeasurementsRepository,private readonly operations:OperationsReadRepository) {}
  private scope(row:GovernanceGoalRow,metric:{filters:unknown},now:Date){
    const today=day(now);if(day(row.periodFrom)>today)return null;
    const query={from:day(row.periodFrom),to:day(row.periodTo)<today?day(row.periodTo):today,...filterScopeSchema.parse(metric.filters)};
    return {key:JSON.stringify(query),query};
  }
  async read(actor:AuthenticatedUser,kind:'kpi'|'objective',query:unknown,id?:string,now=new Date()){
    const snapshot=await this.goals.readSnapshot(actor,kind,query,id,now);
    const requests=new Map<string,unknown>();
    for(const row of snapshot.items){
      if(row.closedAt)continue;
      const metrics='metricId' in row?[row]:row.keyResults.filter(result=>result.kind==='automatic');
      for(const metric of metrics){const scope=this.scope(row,metric,now);if(scope)requests.set(scope.key,scope.query);}
    }
    let periods=new Map<string,Period>();let settings:Awaited<ReturnType<OperationsReadRepository['settings']>>|null=null;
    if(requests.size){
      try{
        [periods,settings]=await Promise.all([this.periods.batch(actor.tenantId,[...requests].map(([key,value])=>({key,query:value})),now),this.operations.settings(actor.tenantId)]);
      }catch(error){
        // Only explicit DW availability failures become unknown automatic values.
        if(!(error instanceof ApplicationError)||error.kind!=='unavailable')throw error;
      }
    }
    const observations=new Map(snapshot.observations.map(value=>[value.id,value.value]));
    const evaluate=(row:GovernanceGoalRow,result:ResultRow|Extract<GovernanceGoalRow,{metricId:string}>):GoalEvaluation=>{
      let current=missing('FUTURE_PERIOD');let provenance:GoalEvaluation['provenance']=null;
      const scope=day(row.periodFrom)<=day(now);
      if(scope&&'kind' in result&&result.kind==='manual')current=measured(observations.get(result.id)??result.baseline.toString());
      else if(scope){
        const configured=this.scope(row,result,now);const period=configured?periods.get(configured.key):undefined;
        const metric=metricIdSchema.safeParse(result.metricId);
        if(!metric.success||result.catalogVersion!==METRIC_CATALOG_VERSION)throw invalid();
        current=missing('WAREHOUSE_UNAVAILABLE');
        if(period&&settings){
          const source=period.closingCut;
          const latest=period.reconciliation;
          const threshold=settings.frequencyHours*3600+settings.delayToleranceMinutes*60;
          const end=day(row.periodTo)<day(now)?Date.parse(`${day(row.periodTo)}T23:59:59.999Z`):now.getTime();
          const cutStale=source?Math.max(0,end-source.at.getTime())>threshold*1000:null;
          const latestStale=latest?Math.max(0,now.getTime()-Date.parse(latest.at))>threshold*1000:true;
          const filters=filterScopeSchema.parse(result.filters);
          const stale=metricDefinition(metric.data).temporalScope==='closing_snapshot'?cutStale===true:latestStale||(hasInventoryScope(filters)&&cutStale===true);
          const measurements=new Map(Object.entries(period.metrics));
          current=measurements.get(metric.data)??missing('OUT_OF_RANGE');
          if(stale&&current.status==='available')current=missing('STALE_DATA');
          provenance={observedAt:period.observedAt?.toISOString()??now.toISOString(),closingCut:source?{runId:source.id,snapshotAt:source.at.toISOString(),publishedAt:source.published.toISOString()}:null,
            engagementReconciliation:latest?{runId:latest.id,snapshotAt:new Date(latest.at).toISOString(),publishedAt:new Date(latest.published).toISOString()}:null,
            tagsAtClosingCut:period.tagsObserved?'observed':'not_observed',creationHistoryStartedAt:period.creationHistoryStartedAt?.toISOString()??null,
            staleAfterSeconds:threshold,frequencyHours:settings.frequencyHours,delayToleranceMinutes:settings.delayToleranceMinutes,closingCutStale:cutStale};
        }
      }
      return output(goalEvaluationSchema,{current,...progress(current,result.baseline.toString(),result.target.toString()),evaluatedAt:now.toISOString(),provenance});
    };
    const items:GovernanceView[]=snapshot.items.map(row=>{
      if(row.closedAt){
        const stored=z.object({evaluation:z.unknown()}).safeParse(row.closingEvaluation);
        if(!stored.success)throw invalid();
        const frozen=kind==='kpi'?output(kpiViewSchema,stored.data.evaluation):output(objectiveViewSchema,stored.data.evaluation);
        if(frozen.id!==row.id)throw invalid();
        return {...frozen,...base(row)} as GovernanceView;
      }
      if('metricId' in row)return output(kpiViewSchema,{...base(row),metricId:row.metricId,catalogVersion:row.catalogVersion,filters:row.filters,
        baseline:row.baseline.toString(),target:row.target.toString(),evaluation:evaluate(row,row)});
      const keyResults=row.keyResults.map(result=>({id:result.id,objectiveId:row.id,title:result.title,ownerId:result.ownerId,kind:result.kind,
        baseline:result.baseline.toString(),target:result.target.toString(),version:result.version,evaluation:evaluate(row,result),
        ...(result.kind==='automatic'?{metricId:result.metricId,catalogVersion:result.catalogVersion,filters:result.filters}:{unit:result.manualUnit})}));
      const aggregate=objectiveProgress(keyResults.map(result=>result.evaluation.progress));
      return output(objectiveViewSchema,{...base(row),description:row.description,keyResults,progress:aggregate,evaluationStatus:aggregate===null?'unavailable':'available'});
    });
    return {items,meta:snapshot.meta};
  }
  async detail(actor:AuthenticatedUser,kind:'kpi'|'objective',id:string,now=new Date()){
    const result=await this.read(actor,kind,{},id,now);const item=result.items[0];if(!item)throw invalid();return item;
  }
  async history(actor:AuthenticatedUser,objectiveId:string,resultId:string,query:unknown){
    const page=await this.goals.progressHistory(actor,objectiveId,resultId,query);
    return {...page,items:page.items.map(row=>({id:row.id,value:row.value.toString(),effectiveDate:day(row.effectiveDate),
      comment:row.comment,recordedById:row.recordedById,recordedAt:row.recordedAt.toISOString()}))};
  }
  async capture(actor:AuthenticatedUser,kind:'kpi'|'objective',id:string,expectedVersion:number,now=new Date()):Promise<GovernanceCapture>{
    requireBiAdmin(actor);const view=await this.detail(actor,kind,id,now);requireVersion(view.version,expectedVersion);
    return {resourceId:id,resourceVersion:view.version,evaluatedAt:now.toISOString(),results:'keyResults' in view?view.keyResults.map(result=>({id:result.id,version:result.version})):[],
      evaluation:JSON.parse(JSON.stringify(view)) as GovernanceCapture['evaluation']};
  }
}
