import {requireBiAdmin,requireVersion,requireDraft,validateManualWrite} from '../src/modules/business-intelligence/utils/governance-policy';
const actor={userId:'editor',tenantId:'tenant',roles:['editor' as const],isActive:true,email:'synthetic@example.test',tenantName:'Synthetic'};
const objective={tenantId:'tenant',state:'active',periodFrom:new Date('2026-10-01Z'),periodTo:new Date('2026-11-30Z')};
const result={tenantId:'tenant',kind:'manual',ownerId:'editor',manualUnit:'count',version:3};
const input={expectedVersion:3,value:'10',effectiveDate:'2026-11-01',comment:'Synthetic observation'};
describe('BI governance authorization and immutable definitions',()=>{
  it('restricts definition writes to active administrators',()=>{expect(()=>requireBiAdmin(actor)).toThrow();expect(()=>requireBiAdmin({...actor,roles:['admin']})).not.toThrow();expect(()=>requireBiAdmin({...actor,roles:['admin'],isActive:false})).toThrow();});
  it('requires the reviewed version and draft definitions',()=>{expect(()=>requireVersion(3,2)).toThrow();expect(()=>requireVersion(3,3)).not.toThrow();for(const state of ['active','closed','archived'])expect(()=>requireDraft(state)).toThrow();});
  it('permits an assigned editor and an administrator to record a manual observation',()=>{expect(()=>validateManualWrite(actor,objective,result,input,'2026-11-01')).not.toThrow();expect(()=>validateManualWrite({...actor,userId:'admin',roles:['admin']},objective,result,input,'2026-11-01')).not.toThrow();});
  it.each([{ownerId:'other'},{kind:'automatic'},{tenantId:'other'},{version:4}])('rejects invalid manual result context %j',change=>{expect(()=>validateManualWrite(actor,objective,{...result,...change},input,'2026-11-01')).toThrow();});
  it.each(['draft','closed','archived'])('rejects writes on an objective in state %s',state=>{expect(()=>validateManualWrite(actor,{...objective,state},result,input,'2026-11-01')).toThrow();});
  it.each(['2026-09-30','2026-12-01','2026-11-02'])('rejects an effective date outside the observable period %s',effectiveDate=>{expect(()=>validateManualWrite(actor,objective,result,{...input,effectiveDate},'2026-11-01')).toThrow();});
  it.each(['-1','1.5','NaN'])('enforces manual count units %s',value=>{expect(()=>validateManualWrite(actor,objective,result,{...input,value},'2026-11-01')).toThrow();});
  it('permits signed numeric observations but rejects inactive writers',()=>{expect(()=>validateManualWrite(actor,objective,{...result,manualUnit:'number'},{...input,value:'-1.5'},'2026-11-01')).not.toThrow();expect(()=>validateManualWrite({...actor,isActive:false},objective,result,input,'2026-11-01')).toThrow();});
});
