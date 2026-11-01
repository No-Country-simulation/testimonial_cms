import {Injectable} from '@nestjs/common';
import {Prisma,type BiKpiGoal} from '@prisma/client';
import {z} from 'zod';
import {PrismaService} from '../../database/prisma.service';
import {BillingAccessRepository} from '../../billing/access';
import {ApplicationError} from '../../../common/errors/application.error';
import type {AuthenticatedUser} from '../../../common/interfaces/auth-context.interface';
import {kpiDefinitionSchema,objectiveDefinitionSchema,keyResultDefinitionSchema,manualProgressSchema,governanceListSchema,governancePageSchema,transitionSchema} from '../contracts/unified-bi.contract';
import {requireBiAdmin,requireVersion,requireDraft,validateManualWrite,requireBiReader,requireEditable,requireSameMetric,requireSameResult,requireTransition,frozen,type GovernanceCapture} from '../utils/governance-policy';
function parse<T>(schema:z.ZodType<T>,input:unknown):T {
  const result=schema.safeParse(input);
  if(!result.success) throw new ApplicationError('Invalid BI governance definition','invalid_input','BI_GOAL_INPUT_INVALID');
  return result.data;
}
export type GovernanceObjectiveRow=Prisma.BiObjectiveGetPayload<{include:{keyResults:true}}> ;
export type GovernanceGoalRow=BiKpiGoal|GovernanceObjectiveRow;
const date=(value:string)=>new Date(`${value}T00:00:00.000Z`);
const notFound=()=>new ApplicationError('Resource not found','not_found','BI_GOAL_NOT_FOUND');
@Injectable()
export class GovernanceRepository {
  constructor(private readonly prisma:PrismaService,private readonly commercial:BillingAccessRepository) {}
  private mutate<T>(actor:AuthenticatedUser,work:(tx:Prisma.TransactionClient)=>Promise<T>,transaction?:Prisma.TransactionClient):Promise<T> {
    const operation=async(tx:Prisma.TransactionClient)=>{
      await this.commercial.checkMutation(actor.tenantId,tx,{feature:'business_intelligence'});
      return work(tx);
    };
    return transaction?operation(transaction):this.prisma.$transaction(operation,{timeout:10000});
  }
  private async owner(tx:Prisma.TransactionClient,tenantId:string,id:string) {
    const owner=await tx.user.findFirst({where:{id,tenantId,isActive:true,roles:{some:{role:{code:{in:['admin','editor']}}}}},select:{id:true}});
    if(!owner) throw new ApplicationError('Owner must be an active member of this workspace','invalid_input','BI_GOAL_OWNER_INVALID');
  }
  private audit(tx:Prisma.TransactionClient,actor:AuthenticatedUser,id:string,action:string,version:number) {
    return tx.auditLog.create({data:{tenantId:actor.tenantId,userId:actor.userId,resourceType:'bi_governance',resourceId:id,action,metadata:{version}}});
  }
  createKpi(actor:AuthenticatedUser,input:unknown,transaction?:Prisma.TransactionClient) {
    requireBiAdmin(actor);const value=parse(kpiDefinitionSchema,input);
    return this.mutate(actor,async tx=>{
      await this.owner(tx,actor.tenantId,value.ownerId);
      const row=await tx.biKpiGoal.create({data:{tenantId:actor.tenantId,title:value.title,ownerId:value.ownerId,
        metricId:value.metricId,catalogVersion:value.catalogVersion,periodFrom:date(value.from),periodTo:date(value.to),
        baseline:value.baseline,target:value.target,filters:value.filters as Prisma.InputJsonValue}});
      await this.audit(tx,actor,row.id,'bi_kpi_created',row.version);return row;
    },transaction);
  }
  createObjective(actor:AuthenticatedUser,input:unknown,transaction?:Prisma.TransactionClient) {
    requireBiAdmin(actor);const value=parse(objectiveDefinitionSchema,input);
    return this.mutate(actor,async tx=>{
      await this.owner(tx,actor.tenantId,value.ownerId);
      const row=await tx.biObjective.create({data:{tenantId:actor.tenantId,title:value.title,description:value.description,
        ownerId:value.ownerId,periodFrom:date(value.from),periodTo:date(value.to)}});
      await this.audit(tx,actor,row.id,'bi_objective_created',row.version);return row;
    },transaction);
  }
  addResult(actor:AuthenticatedUser,objectiveId:string,expectedVersion:number,input:unknown,transaction?:Prisma.TransactionClient) {
    requireBiAdmin(actor);const value=parse(keyResultDefinitionSchema,input);
    return this.mutate(actor,async tx=>{
      await tx.$queryRaw`SELECT id FROM bi_objectives WHERE tenant_id=${actor.tenantId}::uuid AND id=${objectiveId}::uuid FOR UPDATE`;
      const parent=await tx.biObjective.findFirst({where:{id:objectiveId,tenantId:actor.tenantId}});
      if(!parent) throw notFound();requireDraft(parent.state);requireVersion(parent.version,expectedVersion);
      if(await tx.biKeyResult.count({where:{tenantId:actor.tenantId,objectiveId}})>=20)
        throw new ApplicationError('At most twenty key results are allowed','conflict','BI_RESULT_LIMIT');
      await this.owner(tx,actor.tenantId,value.ownerId);
      const configuration=value.kind==='automatic'?{metricId:value.metricId,catalogVersion:value.catalogVersion,filters:value.filters as Prisma.InputJsonValue}
        :{manualUnit:value.unit};
      const row=await tx.biKeyResult.create({data:{tenantId:actor.tenantId,objectiveId,ownerId:value.ownerId,title:value.title,kind:value.kind,
        baseline:value.baseline,target:value.target,...configuration}});
      const updated=await tx.biObjective.update({where:{tenantId_id:{tenantId:actor.tenantId,id:objectiveId}},data:{version:{increment:1}}});
      await this.audit(tx,actor,row.id,'bi_result_created',updated.version);return {result:row,objectiveVersion:updated.version};
    },transaction);
  }
  recordProgress(actor:AuthenticatedUser,objectiveId:string,resultId:string,input:unknown,transaction?:Prisma.TransactionClient) {
    const value=parse(manualProgressSchema,input);
    return this.mutate(actor,async tx=>{
      await tx.$queryRaw`SELECT id FROM bi_objectives WHERE tenant_id=${actor.tenantId}::uuid AND id=${objectiveId}::uuid FOR UPDATE`;
      const parent=await tx.biObjective.findFirst({where:{id:objectiveId,tenantId:actor.tenantId}});
      if(!parent) throw notFound();
      await tx.$queryRaw`SELECT id FROM bi_key_results WHERE tenant_id=${actor.tenantId}::uuid AND objective_id=${objectiveId}::uuid AND id=${resultId}::uuid FOR UPDATE`;
      const result=await tx.biKeyResult.findFirst({where:{id:resultId,tenantId:actor.tenantId,objectiveId}});
      if(!result) throw notFound();validateManualWrite(actor,parent,result,value);
      const entry=await tx.biProgressEntry.create({data:{tenantId:actor.tenantId,objectiveId,keyResultId:resultId,
        recordedById:actor.userId,value:value.value,effectiveDate:date(value.effectiveDate),comment:value.comment}});
      const updated=await tx.biKeyResult.update({where:{tenantId_id:{tenantId:actor.tenantId,id:resultId}},data:{version:{increment:1}}});
      const objective=await tx.biObjective.update({where:{tenantId_id:{tenantId:actor.tenantId,id:objectiveId}},data:{version:{increment:1}}});
      await this.audit(tx,actor,entry.id,'bi_progress_recorded',updated.version);
      return {entry,resultVersion:updated.version,objectiveVersion:objective.version};
    },transaction);
  }
  private async lockGoal(tx:Prisma.TransactionClient,tenantId:string,id:string,kind:'kpi'|'objective') {
    if(kind==='kpi') await tx.$queryRaw`SELECT id FROM bi_kpi_goals WHERE tenant_id=${tenantId}::uuid AND id=${id}::uuid FOR UPDATE`;
    else await tx.$queryRaw`SELECT id FROM bi_objectives WHERE tenant_id=${tenantId}::uuid AND id=${id}::uuid FOR UPDATE`;
    const row=kind==='kpi'?await tx.biKpiGoal.findFirst({where:{id,tenantId}}):await tx.biObjective.findFirst({where:{id,tenantId}});
    if(!row) throw notFound();return row;
  }
  async list(actor:AuthenticatedUser,kind:'kpi'|'objective',input:unknown) {
    requireBiReader(actor);const query=parse(governanceListSchema,input);
    const where={tenantId:actor.tenantId,...(query.state?{state:query.state}:{}),...(query.ownerId?{ownerId:query.ownerId}:{})};
    return this.prisma.$transaction(async tx=>{
      const options={where,orderBy:[{periodTo:'desc' as const},{id:'desc' as const}],skip:(query.page-1)*20,take:20};
      const items=kind==='kpi'?await tx.biKpiGoal.findMany(options):await tx.biObjective.findMany(options);
      const total=kind==='kpi'?await tx.biKpiGoal.count({where}):await tx.biObjective.count({where});
      return {items,meta:{total,page:query.page,limit:20}};
    },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
  }
  async detail(actor:AuthenticatedUser,kind:'kpi'|'objective',id:string) {
    requireBiReader(actor);
    const row=kind==='kpi'?await this.prisma.biKpiGoal.findFirst({where:{id,tenantId:actor.tenantId}})
      :await this.prisma.biObjective.findFirst({where:{id,tenantId:actor.tenantId},include:{keyResults:{orderBy:[{createdAt:'asc'},{id:'asc'}]}}});
    if(!row)throw notFound();return row;
  }
  progressHistory(actor:AuthenticatedUser,objectiveId:string,resultId:string,input:unknown) {
    requireBiReader(actor);const query=parse(governancePageSchema,input);
    return this.prisma.$transaction(async tx=>{
      const result=await tx.biKeyResult.findFirst({where:{id:resultId,objectiveId,tenantId:actor.tenantId},select:{id:true}});
      if(!result)throw notFound();
      const where={tenantId:actor.tenantId,objectiveId,keyResultId:resultId};
      const items=await tx.biProgressEntry.findMany({where,orderBy:[{effectiveDate:'desc'},{recordedAt:'desc'},{id:'desc'}],skip:(query.page-1)*20,take:20});
      const total=await tx.biProgressEntry.count({where});return {items,meta:{page:query.page,limit:20,total}};
    },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
  }
  editKpi(actor:AuthenticatedUser,id:string,expectedVersion:number,input:unknown,transaction?:Prisma.TransactionClient) {
    requireBiAdmin(actor);const value=parse(kpiDefinitionSchema,input);
    return this.mutate(actor,async tx=>{
      const row=await this.lockGoal(tx,actor.tenantId,id,'kpi');requireVersion(row.version,expectedVersion);requireEditable(row.state);
      // Read concrete model to keep the metric configuration type explicit.
      const current=await tx.biKpiGoal.findUniqueOrThrow({where:{tenantId_id:{tenantId:actor.tenantId,id}}});
      if(row.state==='active') requireSameMetric(current,value);
      await this.owner(tx,actor.tenantId,value.ownerId);
      const updated=await tx.biKpiGoal.update({where:{tenantId_id:{tenantId:actor.tenantId,id}},data:{title:value.title,ownerId:value.ownerId,
        metricId:value.metricId,catalogVersion:value.catalogVersion,periodFrom:date(value.from),periodTo:date(value.to),baseline:value.baseline,target:value.target,
        filters:value.filters as Prisma.InputJsonValue,version:{increment:1}}});
      await this.audit(tx,actor,id,'bi_kpi_edited',updated.version);return updated;
    },transaction);
  }
  editObjective(actor:AuthenticatedUser,id:string,expectedVersion:number,input:unknown,transaction?:Prisma.TransactionClient) {
    requireBiAdmin(actor);const value=parse(objectiveDefinitionSchema,input);
    return this.mutate(actor,async tx=>{
      const row=await this.lockGoal(tx,actor.tenantId,id,'objective');requireVersion(row.version,expectedVersion);requireEditable(row.state);
      if(row.state==='active'&&(row.periodFrom.toISOString().slice(0,10)!==value.from||row.periodTo.toISOString().slice(0,10)!==value.to))throw frozen();
      await this.owner(tx,actor.tenantId,value.ownerId);
      const updated=await tx.biObjective.update({where:{tenantId_id:{tenantId:actor.tenantId,id}},data:{title:value.title,description:value.description,
        ownerId:value.ownerId,periodFrom:date(value.from),periodTo:date(value.to),version:{increment:1}}});
      await this.audit(tx,actor,id,'bi_objective_edited',updated.version);return updated;
    },transaction);
  }
  editResult(actor:AuthenticatedUser,objectiveId:string,resultId:string,expectedObjectiveVersion:number,expectedVersion:number,input:unknown,transaction?:Prisma.TransactionClient) {
    requireBiAdmin(actor);const value=parse(keyResultDefinitionSchema,input);
    return this.mutate(actor,async tx=>{
      const parent=await this.lockGoal(tx,actor.tenantId,objectiveId,'objective');requireVersion(parent.version,expectedObjectiveVersion);requireEditable(parent.state);
      await tx.$queryRaw`SELECT id FROM bi_key_results WHERE tenant_id=${actor.tenantId}::uuid AND objective_id=${objectiveId}::uuid AND id=${resultId}::uuid FOR UPDATE`;
      const row=await tx.biKeyResult.findFirst({where:{tenantId:actor.tenantId,objectiveId,id:resultId}});if(!row)throw notFound();requireVersion(row.version,expectedVersion);
      if(parent.state==='active')requireSameResult(row,value);
      await this.owner(tx,actor.tenantId,value.ownerId);
      const configuration=value.kind==='automatic'?{metricId:value.metricId,catalogVersion:value.catalogVersion,manualUnit:null,filters:value.filters as Prisma.InputJsonValue}
        :{metricId:null,catalogVersion:null,manualUnit:value.unit,filters:Prisma.DbNull};
      const updated=await tx.biKeyResult.update({where:{tenantId_id:{tenantId:actor.tenantId,id:resultId}},data:{title:value.title,ownerId:value.ownerId,
        kind:value.kind,baseline:value.baseline,target:value.target,...configuration,version:{increment:1}}});
      const objective=await tx.biObjective.update({where:{tenantId_id:{tenantId:actor.tenantId,id:objectiveId}},data:{version:{increment:1}}});
      await this.audit(tx,actor,resultId,'bi_result_edited',updated.version);return {result:updated,objectiveVersion:objective.version};
    },transaction);
  }
  transition(actor:AuthenticatedUser,kind:'kpi'|'objective',id:string,input:unknown,capture?:GovernanceCapture,transaction?:Prisma.TransactionClient) {
    requireBiAdmin(actor);const value=parse(transitionSchema,input);
    return this.mutate(actor,async tx=>{
      const row=await this.lockGoal(tx,actor.tenantId,id,kind);requireVersion(row.version,value.expectedVersion);
      const results=kind==='objective'?await tx.biKeyResult.findMany({where:{tenantId:actor.tenantId,objectiveId:id},orderBy:{id:'asc'}}):[];
      requireTransition(row.state,value.action,kind==='objective'?results.length:1);
      if(value.action==='activate'){
        const ids=[...new Set([row.ownerId,...results.map(result=>result.ownerId)])];
        const owners=await tx.user.count({where:{tenantId:actor.tenantId,id:{in:ids},isActive:true,roles:{some:{role:{code:{in:['admin','editor']}}}}}});
        if(owners!==ids.length)throw new ApplicationError('Owners must remain active workspace members','conflict','BI_GOAL_OWNER_INVALID');
      }
      let closing:Prisma.InputJsonValue|undefined;
      if(value.action==='close'){
        if(!capture||capture.resourceId!==id||capture.resourceVersion!==row.version||capture.results.length!==results.length||
          results.some(result=>!capture.results.some(observed=>observed.id===result.id&&observed.version===result.version)))
          throw new ApplicationError('Evaluation was not captured for the current definition','conflict','BI_GOAL_VERSION_CONFLICT');
        // DW computation is done before this transaction by the application service.
        closing=JSON.parse(JSON.stringify({definition:row,keyResults:results,evaluation:capture.evaluation,evaluatedAt:capture.evaluatedAt})) as Prisma.InputJsonValue;
      }
      const now=new Date();
      const data={state:value.action==='activate'?'active':value.action==='close'?'closed':'archived',version:{increment:1},
        ...(value.action==='activate'?{activatedAt:now}:{}),...(value.action==='close'?{closedAt:now,closingEvaluation:closing!}:{}),
        ...(value.action==='archive'?{archivedAt:now}:{})};
      const updated=kind==='kpi'?await tx.biKpiGoal.update({where:{tenantId_id:{tenantId:actor.tenantId,id}},data})
        :await tx.biObjective.update({where:{tenantId_id:{tenantId:actor.tenantId,id}},data});
      await this.audit(tx,actor,id,`bi_goal_${value.action}`,updated.version);return updated;
    },transaction);
  }

  readSnapshot(actor:AuthenticatedUser,kind:'kpi'|'objective',input:unknown,id?:string,at=new Date()) {
    requireBiReader(actor);const query=parse(governanceListSchema,input);
    const where={tenantId:actor.tenantId,...(id?{id}:{}),...(query.state?{state:query.state}:{}),...(query.ownerId?{ownerId:query.ownerId}:{})};
    return this.prisma.$transaction(async tx=>{
      const options={where,orderBy:[{periodTo:'desc' as const},{id:'desc' as const}],skip:id?0:(query.page-1)*20,take:id?1:20};
      const items:GovernanceGoalRow[]=kind==='kpi'?await tx.biKpiGoal.findMany(options)
        :await tx.biObjective.findMany({...options,include:{keyResults:{orderBy:[{createdAt:'asc'},{id:'asc'}]}}});
      if(id&&!items.length)throw notFound();
      const total=id?items.length:kind==='kpi'?await tx.biKpiGoal.count({where}):await tx.biObjective.count({where});
      const objectives=items.filter((row):row is GovernanceObjectiveRow=>'keyResults' in row);
      const ids=objectives.map(row=>row.id);
      const observations=ids.length?await tx.$queryRaw<Array<{id:string;value:string}>>(Prisma.sql`SELECT DISTINCT ON (p.key_result_id)
        p.key_result_id AS id,p.value::text AS value FROM bi_progress_entries p
        JOIN bi_objectives o ON o.tenant_id=p.tenant_id AND o.id=p.objective_id
        WHERE p.tenant_id=${actor.tenantId}::uuid AND p.objective_id IN (${Prisma.join(ids.map(value=>Prisma.sql`${value}::uuid`))})
        AND p.effective_date BETWEEN o.period_from AND least(o.period_to,(${at}::timestamptz AT TIME ZONE 'UTC')::date)
        ORDER BY p.key_result_id,p.effective_date DESC,p.recorded_at DESC,p.id DESC`):[];
      return {items,observations,meta:{total,page:query.page,limit:20}};
    },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
  }

}
