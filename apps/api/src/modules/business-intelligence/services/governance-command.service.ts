import {Injectable} from '@nestjs/common';
import {ApplicationError} from '../../../common/errors/application.error';
import type {AuthenticatedUser} from '../../../common/interfaces/auth-context.interface';
import {IdempotencyService,type IdempotencyRequest} from '../../../common/services/idempotency.service';
import type {TransactionClient} from '../../../common/repositories/transaction-client';
import {GovernanceRepository} from '../repositories/governance.repository';
import {PeriodMeasurementsRepository} from '../repositories/period-measurements.repository';
import {GovernanceEvaluationService} from './governance-evaluation.service';
import {requireBiAdmin,requireBiReader} from '../utils/governance-policy';
import {transitionSchema,kpiDefinitionSchema,keyResultDefinitionSchema} from '../contracts/unified-bi.contract';
@Injectable()
export class GovernanceCommandService {
  constructor(private readonly goals:GovernanceRepository,private readonly evaluations:GovernanceEvaluationService,private readonly idempotency:IdempotencyService,private readonly periods:PeriodMeasurementsRepository) {}
  private request(actor:AuthenticatedUser,key:string|undefined,path:string,payload:unknown,statusCode:200|201):IdempotencyRequest {
    if(key===undefined||!/^[A-Za-z0-9._~-]{1,128}$/.test(key))throw new ApplicationError('Idempotency-Key is required','invalid_input','IDEMPOTENCY_KEY_INVALID');
    return {key,tenantId:actor.tenantId,principalKind:'user',principalId:actor.userId,method:'POST',path:`/api/v1/bi/${path}`,payload,statusCode};
  }
  private tx(value:TransactionClient|undefined):TransactionClient {
    if(!value)throw new ApplicationError('Transactional mutation required','internal','BI_TRANSACTION_REQUIRED');return value;
  }
  async create(actor:AuthenticatedUser,kind:'kpi'|'objective',body:unknown,key:string|undefined){
    requireBiAdmin(actor);const request=this.request(actor,key,kind==='kpi'?'kpis':'objectives',body,201);
    const result=await this.idempotency.executePrepared(request,async()=>{
      if(kind==='kpi'){
        const definition=kpiDefinitionSchema.safeParse(body);
        if(!definition.success)throw new ApplicationError('Invalid KPI definition','invalid_input','BI_GOAL_INPUT_INVALID');
        await this.periods.validateScope(actor.tenantId,definition.data.filters);
      }
    },async(_prepared,tx)=>{
      const row=kind==='kpi'?await this.goals.createKpi(actor,body,this.tx(tx)):await this.goals.createObjective(actor,body,this.tx(tx));
      return {id:row.id,state:row.state,version:row.version};
    });return result.value;
  }
  async addResult(actor:AuthenticatedUser,id:string,body:{expectedVersion:number;definition:unknown},key:string|undefined){
    requireBiAdmin(actor);const request=this.request(actor,key,`objectives/${id}/key-results`,body,201);
    const result=await this.idempotency.executePrepared(request,async()=>{
      const definition=keyResultDefinitionSchema.safeParse(body.definition);
      if(!definition.success)throw new ApplicationError('Invalid key result','invalid_input','BI_GOAL_INPUT_INVALID');
      if(definition.data.kind==='automatic')await this.periods.validateScope(actor.tenantId,definition.data.filters);
    },async(_prepared,tx)=>{
      const row=await this.goals.addResult(actor,id,body.expectedVersion,body.definition,this.tx(tx));
      return {id:row.result.id,objectiveId:id,version:row.result.version,objectiveVersion:row.objectiveVersion};
    });return result.value;
  }
  async recordProgress(actor:AuthenticatedUser,id:string,resultId:string,body:unknown,key:string|undefined){
    requireBiReader(actor);const request=this.request(actor,key,`objectives/${id}/key-results/${resultId}/progress`,body,201);
    const result=await this.idempotency.execute(request,async tx=>{
      const row=await this.goals.recordProgress(actor,id,resultId,body,this.tx(tx));
      return {id:row.entry.id,resultVersion:row.resultVersion,objectiveVersion:row.objectiveVersion};
    });return result.value;
  }
  async transition(actor:AuthenticatedUser,kind:'kpi'|'objective',id:string,body:unknown,key:string|undefined){
    requireBiAdmin(actor);const parsed=transitionSchema.safeParse(body);
    if(!parsed.success)throw new ApplicationError('Invalid transition','invalid_input','BI_GOAL_INPUT_INVALID');
    const input=parsed.data;const request=this.request(actor,key,`${kind==='kpi'?'kpis':'objectives'}/${id}/transitions`,input,200);
    const result=await this.idempotency.executePrepared(request,
      async()=>input.action==='close'?this.evaluations.capture(actor,kind,id,input.expectedVersion):undefined,
      async(capture,tx)=>{
        const row=await this.goals.transition(actor,kind,id,input,capture,this.tx(tx));
        return {id:row.id,state:row.state,version:row.version};
      });return result.value;
  }
  async edit(actor:AuthenticatedUser,kind:'kpi'|'objective',id:string,body:{expectedVersion:number;definition:unknown}){
    requireBiAdmin(actor);
    if(kind==='kpi'){const current=await this.goals.detail(actor,'kpi',id);if(current.state==='draft'){const definition=kpiDefinitionSchema.parse(body.definition);await this.periods.validateScope(actor.tenantId,definition.filters);}}
    const row=kind==='kpi'?await this.goals.editKpi(actor,id,body.expectedVersion,body.definition):await this.goals.editObjective(actor,id,body.expectedVersion,body.definition);
    return {id:row.id,state:row.state,version:row.version};
  }
  async editResult(actor:AuthenticatedUser,id:string,resultId:string,body:{expectedVersion:number;expectedObjectiveVersion:number;definition:unknown}){
    requireBiAdmin(actor);const parent=await this.goals.detail(actor,'objective',id);
    if(parent.state==='draft'){const definition=keyResultDefinitionSchema.parse(body.definition);if(definition.kind==='automatic')await this.periods.validateScope(actor.tenantId,definition.filters);}
    const row=await this.goals.editResult(actor,id,resultId,body.expectedObjectiveVersion,body.expectedVersion,body.definition);
    return {id:row.result.id,objectiveId:id,version:row.result.version,objectiveVersion:row.objectiveVersion};
  }
}
