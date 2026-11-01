import {Injectable} from '@nestjs/common';
import {Prisma} from '@prisma/client';
import {z} from 'zod';
import {PrismaService} from '../../database/prisma.service';
import {BillingAccessRepository} from '../../billing/access';
import {ApplicationError} from '../../../common/errors/application.error';
import type {AuthenticatedUser} from '../../../common/interfaces/auth-context.interface';
import {kpiDefinitionSchema,objectiveDefinitionSchema,keyResultDefinitionSchema,manualProgressSchema} from '../contracts/unified-bi.contract';
import {requireBiAdmin,requireVersion,requireDraft,validateManualWrite} from '../utils/governance-policy';
function parse<T>(schema:z.ZodType<T>,input:unknown):T {
  const result=schema.safeParse(input);
  if(!result.success) throw new ApplicationError('Invalid BI governance definition','invalid_input','BI_GOAL_INPUT_INVALID');
  return result.data;
}
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
}
