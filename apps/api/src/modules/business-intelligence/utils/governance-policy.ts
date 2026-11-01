import {Prisma} from '@prisma/client';
import {ApplicationError} from '../../../common/errors/application.error';
import type {AuthenticatedUser} from '../../../common/interfaces/auth-context.interface';
import type {z} from 'zod';
import type {BiKeyResultDefinition} from '../contracts/unified-bi.contract';
import {filterScopeSchema,manualProgressSchema} from '../contracts/unified-bi.contract';
export function requireBiAdmin(actor:AuthenticatedUser) {
  if(!actor.isActive||!actor.roles.includes('admin')) throw new ApplicationError('Administrator required','forbidden','BI_ADMIN_REQUIRED');
}
export function requireVersion(actual:number,expected:number) {
  if(actual!==expected) throw new ApplicationError('Reload and review the latest version','conflict','BI_GOAL_VERSION_CONFLICT');
}
export function requireDraft(state:string) {
  if(state!=='draft') throw new ApplicationError('Definitions are frozen after activation','conflict','BI_GOAL_FROZEN');
}
export function validateManualWrite(actor:AuthenticatedUser,
  objective:{tenantId:string;state:string;periodFrom:Date;periodTo:Date},
  result:{tenantId:string;kind:string;ownerId:string;manualUnit:string|null;version:number},
  input:z.infer<typeof manualProgressSchema>,today=new Date().toISOString().slice(0,10)) {
  if(actor.tenantId!==objective.tenantId||actor.tenantId!==result.tenantId)
    throw new ApplicationError('Result not found','not_found','BI_GOAL_NOT_FOUND');
  if(!actor.isActive||(!actor.roles.includes('admin')&&!(actor.roles.includes('editor')&&actor.userId===result.ownerId)))
    throw new ApplicationError('Only the assigned editor or an administrator may record progress','forbidden','BI_RESULT_ASSIGNEE_REQUIRED');
  if(objective.state!=='active'||result.kind!=='manual')
    throw new ApplicationError('Only active manual results accept progress','conflict','BI_PROGRESS_NOT_ALLOWED');
  requireVersion(result.version,input.expectedVersion);
  if(input.effectiveDate<objective.periodFrom.toISOString().slice(0,10)||input.effectiveDate>objective.periodTo.toISOString().slice(0,10)||input.effectiveDate>today)
    throw new ApplicationError('Effective date must be within the objective period and not in the future','invalid_input','BI_PROGRESS_DATE_INVALID');
  const value=new Prisma.Decimal(input.value);
  if(!value.isFinite()||(!['count','percentage','number'].includes(result.manualUnit??''))||
    (result.manualUnit!=='number'&&(value.isNegative()||(result.manualUnit==='count'&&!value.isInteger()))))
    throw new ApplicationError('Progress value is outside the result unit domain','invalid_input','BI_PROGRESS_VALUE_INVALID');
}

export const frozen=()=>new ApplicationError('Definitions are immutable in this lifecycle state','conflict','BI_GOAL_FROZEN');
export function requireBiReader(actor:AuthenticatedUser) {
  if(!actor.isActive||!actor.roles.some(role=>role==='admin'||role==='editor'))throw new ApplicationError('BI access required','forbidden','BI_ACCESS_REQUIRED');
}
export function requireEditable(state:string) {if(state!=='draft'&&state!=='active')throw frozen();}
export function requireTransition(state:string,action:'activate'|'close'|'archive',results:number) {
  if(action==='activate'&&(state!=='draft'||results<1||results>20))throw frozen();
  if(action==='close'&&state!=='active')throw frozen();
  if(action==='archive'&&!['draft','active','closed'].includes(state))throw frozen();
}
type StoredMetric={baseline:Prisma.Decimal;target:Prisma.Decimal;metricId:string|null;catalogVersion:string|null;filters:Prisma.JsonValue;periodFrom?:Date;periodTo?:Date};
export function requireSameMetric(current:StoredMetric,value:{baseline:string;target:string;metricId:string;catalogVersion:string;filters:unknown;from?:string;to?:string}) {
  if(!current.baseline.eq(value.baseline)||!current.target.eq(value.target)||current.metricId!==value.metricId||current.catalogVersion!==value.catalogVersion||
    JSON.stringify(filterScopeSchema.parse(current.filters))!==JSON.stringify(filterScopeSchema.parse(value.filters))||
    (value.from!==undefined&&current.periodFrom?.toISOString().slice(0,10)!==value.from)||(value.to!==undefined&&current.periodTo?.toISOString().slice(0,10)!==value.to))throw frozen();
}
export function requireSameResult(current:StoredMetric&{kind:string;manualUnit:string|null},value:BiKeyResultDefinition) {
  if(current.kind!==value.kind)throw frozen();
  if(value.kind==='automatic')requireSameMetric(current,value);
  else if(!current.baseline.eq(value.baseline)||!current.target.eq(value.target)||current.manualUnit!==value.unit)throw frozen();
}
/** Supplied by the application service, never accepted from an HTTP request body. */
export interface GovernanceCapture {
  resourceId:string;resourceVersion:number;evaluatedAt:string;
  results:Array<{id:string;version:number}>;
  evaluation:Prisma.InputJsonValue;
}
