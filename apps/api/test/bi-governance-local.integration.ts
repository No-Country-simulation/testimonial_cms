import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir,userInfo} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {PrismaService} from '../src/modules/database/prisma.service';
import type {BillingAccessRepository} from '../src/modules/billing/access';
import {IdempotencyRepository} from '../src/common/repositories/idempotency.repository';
import {IdempotencyService} from '../src/common/services/idempotency.service';
import {GovernanceEvaluationService} from '../src/modules/business-intelligence/services/governance-evaluation.service';
import {ActivityRepository} from '../src/modules/business-intelligence/repositories/activity.repository';
import {GovernanceCommandService} from '../src/modules/business-intelligence/services/governance-command.service';
import {ApplicationError} from '../src/common/errors/application.error';
import {GovernanceRepository} from '../src/modules/business-intelligence/repositories/governance.repository';
import type {AuthenticatedUser} from '../src/common/interfaces/auth-context.interface';
import {PrismaClient} from '@prisma/client';
const exec=promisify(execFile);
const run=process.env.TEST_BI_GOVERNANCE_LOCAL==='true'?describe:describe.skip;
run('BI governance additive SQL on an owned PostgreSQL cluster',()=>{
  jest.setTimeout(60000);
  let root:string;let started=false;let admin:PrismaClient;let repository:GovernanceRepository;let evaluation:GovernanceEvaluationService;let commands:GovernanceCommandService;
  const adminId=randomUUID();
  const tenant=randomUUID(),other=randomUUID(),owner=randomUUID(),foreign=randomUUID(),objective=randomUUID(),result=randomUUID();
  beforeAll(async()=>{
    root=await mkdtemp(join(tmpdir(),'bi-governance-owned-'));
    await exec('initdb',['-D',join(root,'data'),'-A','trust','--no-locale','-E','UTF8']);
    await exec('pg_ctl',['-D',join(root,'data'),'-l',join(root,'postgres.log'),'-o',`-k ${root} -h '' -p 55440`,'-w','start']);started=true;
    const url=new URL(`postgresql://${userInfo().username}@localhost:55440/postgres`);url.searchParams.set('host',root);
    admin=new PrismaClient({datasources:{db:{url:url.toString()}},log:[]});
    // Minimal parent tables test declared BI FKs, not the full CMS/auth runtime.
    await admin.$executeRaw`CREATE TABLE tenants(id uuid PRIMARY KEY)`;
    await admin.$executeRaw`CREATE TABLE users(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),is_active boolean NOT NULL DEFAULT true,UNIQUE(tenant_id,id))`;
    await admin.$executeRaw`CREATE TABLE roles(id int PRIMARY KEY,code text NOT NULL)`;
    await admin.$executeRaw`CREATE TABLE user_roles(user_id uuid NOT NULL REFERENCES users(id),role_id int NOT NULL REFERENCES roles(id),PRIMARY KEY(user_id,role_id))`;
    await admin.$executeRaw`CREATE TABLE audit_logs(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,tenant_id uuid REFERENCES tenants(id),user_id uuid REFERENCES users(id),action text NOT NULL,resource_type text NOT NULL,resource_id text,metadata jsonb,created_at timestamptz(3) NOT NULL DEFAULT now())`;
    await exec('psql',['-X','-v','ON_ERROR_STOP=1','-h',root,'-p','55440','-U',userInfo().username,'-d','postgres','-f',join(__dirname,'../prisma/migrations/20261101000000_bi_governance/migration.sql')]);
    await admin.$executeRaw`INSERT INTO tenants VALUES(${tenant}::uuid),(${other}::uuid)`;
    await admin.$executeRaw`INSERT INTO users(id,tenant_id) VALUES(${owner}::uuid,${tenant}::uuid),(${foreign}::uuid,${other}::uuid),(${adminId}::uuid,${tenant}::uuid)`;
    await admin.$executeRaw`INSERT INTO roles VALUES(1,'admin'),(2,'editor')`;
    await admin.$executeRaw`INSERT INTO user_roles VALUES(${owner}::uuid,2),(${adminId}::uuid,1)`;
    await admin.$executeRaw`CREATE TABLE idempotency_keys(id uuid PRIMARY KEY,key text NOT NULL,tenant_id uuid NOT NULL REFERENCES tenants(id),principal_kind text NOT NULL,principal_id text NOT NULL,method text NOT NULL,path text NOT NULL,request_hash text NOT NULL,record_state text NOT NULL,status_code integer,response_body jsonb,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,UNIQUE(tenant_id,principal_kind,principal_id,method,path,key))`;
    repository=new GovernanceRepository(admin as unknown as PrismaService,{checkMutation:async()=>undefined} as unknown as BillingAccessRepository);
    evaluation=new GovernanceEvaluationService(repository,{batch:async()=>{throw new ApplicationError('Synthetic unavailable DW','unavailable','BI_UNAVAILABLE');}} as never,{settings:async()=>{throw new ApplicationError('Synthetic unavailable DW','unavailable','BI_UNAVAILABLE');}} as never);
    commands=new GovernanceCommandService(repository,evaluation,new IdempotencyService(new IdempotencyRepository(admin as unknown as PrismaService)),{validateScope:async()=>undefined} as never);
    await admin.$executeRaw`INSERT INTO bi_objectives(id,tenant_id,owner_id,title,period_from,period_to) VALUES
      (${objective}::uuid,${tenant}::uuid,${owner}::uuid,'Synthetic objective','2026-10-01','2026-12-31')`;
    await admin.$executeRaw`INSERT INTO bi_key_results(id,tenant_id,objective_id,owner_id,title,kind,manual_unit,baseline,target)
      VALUES(${result}::uuid,${tenant}::uuid,${objective}::uuid,${owner}::uuid,'Synthetic manual result','manual','count',0,100)`;
  });
  afterAll(async()=>{
    await admin?.$disconnect();if(started)await exec('pg_ctl',['-D',join(root,'data'),'-m','immediate','-w','stop']);
    if(root)await rm(root,{recursive:true,force:true});
  });
  it('supports the generated Prisma models against the actual migration',async()=>{
    expect(await admin.biObjective.findUnique({where:{id:objective}})).toMatchObject({tenantId:tenant,state:'draft',version:0});
    expect(await admin.biKeyResult.findUnique({where:{id:result}})).toMatchObject({kind:'manual',manualUnit:'count'});
  });
  it('rejects cross-tenant owners through the composite foreign key',async()=>{
    await expect(admin.$executeRaw`INSERT INTO bi_objectives(tenant_id,owner_id,title,period_from,period_to)
      VALUES(${tenant}::uuid,${foreign}::uuid,'Synthetic foreign owner','2026-10-01','2026-12-31')`).rejects.toMatchObject({code:'P2010',meta:{code:'23503'}});
  });
  it('rejects nonfinite/equal targets and invalid periods',async()=>{
    await expect(admin.$executeRaw`UPDATE bi_key_results SET baseline='NaN'::numeric WHERE id=${result}::uuid`).rejects.toMatchObject({code:'P2010',meta:{code:'23514'}});
    await expect(admin.$executeRaw`UPDATE bi_key_results SET target=baseline WHERE id=${result}::uuid`).rejects.toMatchObject({code:'P2010',meta:{code:'23514'}});
    await expect(admin.$executeRaw`UPDATE bi_objectives SET period_to='2028-01-01' WHERE id=${objective}::uuid`).rejects.toMatchObject({code:'P2010',meta:{code:'23514'}});
  });
  it('keeps manual observations append-only, including against the owner identity',async()=>{
    const entry=await admin.biProgressEntry.create({data:{tenantId:tenant,objectiveId:objective,keyResultId:result,recordedById:owner,value:'25',effectiveDate:new Date('2026-11-01Z'),comment:'Synthetic observation'}});
    await expect(admin.$executeRaw`UPDATE bi_progress_entries SET value=50 WHERE id=${entry.id}::uuid`).rejects.toMatchObject({code:'P2010',meta:{code:'23514'}});
    await expect(admin.$executeRaw`DELETE FROM bi_progress_entries WHERE id=${entry.id}::uuid`).rejects.toMatchObject({code:'P2010',meta:{code:'23514'}});
    expect((await admin.biProgressEntry.findUniqueOrThrow({where:{id:entry.id}})).value.toString()).toBe('25');
  });
  it('prevents observations from being associated with another tenant',async()=>{
    await expect(admin.$executeRaw`INSERT INTO bi_progress_entries(tenant_id,objective_id,key_result_id,recorded_by_id,value,effective_date,comment)
      VALUES(${other}::uuid,${objective}::uuid,${result}::uuid,${foreign}::uuid,1,'2026-11-01','Synthetic invalid link')`).rejects.toMatchObject({code:'P2010',meta:{code:'23503'}});
  });
  function actor(editor=false):AuthenticatedUser{return {userId:editor?owner:adminId,tenantId:tenant,tenantName:'Synthetic',email:'synthetic@example.test',isActive:true,roles:[editor?'editor':'admin']};}
  async function activeObjective(){
    const parent=await repository.createObjective(actor(),{title:'Synthetic flow',ownerId:owner,from:'2026-10-01',to:'2026-12-31'});
    const child=await repository.addResult(actor(),parent.id,0,{title:'Synthetic count',ownerId:owner,kind:'manual',unit:'count',baseline:'0',target:'100'});
    await repository.transition(actor(),'objective',parent.id,{expectedVersion:1,action:'activate'});
    return {parent,child:child.result};
  }
  it('executes audited create, activation, assigned progress, frozen close and archive',async()=>{
    const {parent,child}=await activeObjective();
    const advance=await repository.recordProgress(actor(true),parent.id,child.id,{expectedVersion:0,value:'25',effectiveDate:'2026-11-01',comment:'Synthetic observation'});
    expect(advance.resultVersion).toBe(1);expect(advance.objectiveVersion).toBe(3);
    const closed=await repository.transition(actor(),'objective',parent.id,{expectedVersion:3,action:'close'},{resourceId:parent.id,resourceVersion:3,evaluatedAt:new Date().toISOString(),results:[{id:child.id,version:1}],evaluation:{progress:'25'}});
    expect(closed.state).toBe('closed');expect(closed.closingEvaluation).toHaveProperty('evaluation.progress','25');
    await expect(repository.recordProgress(actor(true),parent.id,child.id,{expectedVersion:1,value:'50',effectiveDate:'2026-11-01',comment:'Synthetic invalid closed observation'})).rejects.toMatchObject({code:'BI_PROGRESS_NOT_ALLOWED'});
    await repository.transition(actor(),'objective',parent.id,{expectedVersion:4,action:'archive'});
    expect((await repository.progressHistory(actor(),parent.id,child.id,{})).meta.total).toBe(1);
    expect(await admin.auditLog.count({where:{tenantId:tenant,resourceId:advance.entry.id,action:'bi_progress_recorded'}})).toBe(1);
  });
  it('serializes competing manual writes and rejects stale captures',async()=>{
    const {parent,child}=await activeObjective();
    const outcomes=await Promise.allSettled(['10','20'].map(value=>repository.recordProgress(actor(true),parent.id,child.id,{expectedVersion:0,value,effectiveDate:'2026-11-01',comment:'Synthetic concurrent observation'})));
    expect(outcomes.filter(value=>value.status==='fulfilled')).toHaveLength(1);
    expect(outcomes.filter(value=>value.status==='rejected')).toHaveLength(1);
    expect(await admin.biProgressEntry.count({where:{tenantId:tenant,keyResultId:child.id}})).toBe(1);
    await expect(repository.transition(actor(),'objective',parent.id,{expectedVersion:3,action:'close'},{resourceId:parent.id,resourceVersion:2,evaluatedAt:new Date().toISOString(),results:[{id:child.id,version:0}],evaluation:{progress:'0'}})).rejects.toMatchObject({code:'BI_GOAL_VERSION_CONFLICT'});
  });
  it('keeps active definitions frozen while permitting administrator titles',async()=>{
    const {parent}=await activeObjective();
    const definition={title:'Renamed synthetic flow',ownerId:owner,from:'2026-10-01',to:'2026-12-31'};
    expect((await repository.editObjective(actor(),parent.id,2,definition)).title).toBe(definition.title);
    await expect(repository.editObjective(actor(),parent.id,3,{...definition,to:'2026-12-30'})).rejects.toMatchObject({code:'BI_GOAL_FROZEN'});
    await expect(repository.detail({...actor(),tenantId:other},'objective',parent.id)).rejects.toMatchObject({code:'BI_GOAL_NOT_FOUND'});
    expect((await repository.list(actor(),'objective',{})).meta.total).toBeGreaterThan(0);
  });

  it('freezes active KPI metric definitions and closes using a matching capture',async()=>{
    const definition={title:'Synthetic views',ownerId:owner,from:'2026-10-01',to:'2026-12-31',metricId:'views',filters:{},baseline:'0',target:'100'};
    const kpi=await repository.createKpi(actor(),definition);
    await repository.transition(actor(),'kpi',kpi.id,{expectedVersion:0,action:'activate'});
    const edited=await repository.editKpi(actor(),kpi.id,1,{...definition,title:'Renamed synthetic views',baseline:'0.00'});
    expect(edited.version).toBe(2);
    await expect(repository.editKpi(actor(),kpi.id,2,{...definition,target:'200'})).rejects.toMatchObject({code:'BI_GOAL_FROZEN'});
    const closed=await repository.transition(actor(),'kpi',kpi.id,{expectedVersion:2,action:'close'},{resourceId:kpi.id,resourceVersion:2,evaluatedAt:new Date().toISOString(),results:[],evaluation:{current:{status:'unavailable',value:null,reason:'WAREHOUSE_UNAVAILABLE'}}});
    expect(closed.state).toBe('closed');expect(closed.closingEvaluation).toHaveProperty('evaluation.current.reason','WAREHOUSE_UNAVAILABLE');
  });
  it('allows active result reassignment without changing the frozen definition',async()=>{
    const {parent,child}=await activeObjective();
    const definition={title:'Reassigned synthetic result',ownerId:adminId,kind:'manual',unit:'count',baseline:'0',target:'100'};
    const updated=await repository.editResult(actor(),parent.id,child.id,2,0,definition);
    expect(updated.objectiveVersion).toBe(3);expect(updated.result.version).toBe(1);
    await expect(repository.recordProgress(actor(true),parent.id,child.id,{expectedVersion:1,value:'5',effectiveDate:'2026-11-01',comment:'Synthetic old assignee'})).rejects.toMatchObject({code:'BI_RESULT_ASSIGNEE_REQUIRED'});
    await expect(repository.editResult(actor(),parent.id,child.id,3,1,{...definition,unit:'number'})).rejects.toMatchObject({code:'BI_GOAL_FROZEN'});
  });
  it('rejects activation with no key results and rejects editor definition writes',async()=>{
    const parent=await repository.createObjective(actor(),{title:'Synthetic empty draft',ownerId:owner,from:'2026-10-01',to:'2026-12-31'});
    await expect(repository.transition(actor(),'objective',parent.id,{expectedVersion:0,action:'activate'})).rejects.toMatchObject({code:'BI_GOAL_FROZEN'});
    expect(()=>repository.createObjective(actor(true),{title:'Synthetic editor draft',ownerId:owner,from:'2026-10-01',to:'2026-12-31'})).toThrow(expect.objectContaining({code:'BI_ADMIN_REQUIRED'}));
    expect((await repository.detail(actor(),'objective',parent.id)).version).toBe(0);
  });

  it('executes prepared idempotent commands and recovers a closed result without recapturing',async()=>{
    const definition={title:'Synthetic idempotent objective',ownerId:owner,from:'2026-11-01',to:'2026-11-30'};
    const created=await commands.create(actor(),'objective',definition,'flow-create');
    expect(await commands.create(actor(),'objective',definition,'flow-create')).toEqual(created);
    const child=await commands.addResult(actor(),created.id,{expectedVersion:0,definition:{title:'Synthetic manual',ownerId:owner,kind:'manual',unit:'count',baseline:'0',target:'100'}},'flow-result');
    await commands.transition(actor(),'objective',created.id,{expectedVersion:1,action:'activate'},'flow-activate');
    const progress=await commands.recordProgress(actor(true),created.id,child.id,{expectedVersion:0,value:'25',effectiveDate:'2026-11-01',comment:'Synthetic idempotent observation'},'flow-progress');
    const input={expectedVersion:3,action:'close'};
    const closed=await commands.transition(actor(),'objective',created.id,input,'flow-close');
    const spy=jest.spyOn(evaluation,'capture').mockRejectedValue(new Error('Evaluation must not run on a completed replay'));
    try{
      expect(await commands.transition(actor(),'objective',created.id,input,'flow-close')).toEqual(closed);
      expect(spy).not.toHaveBeenCalled();
      expect(await commands.recordProgress(actor(true),created.id,child.id,{expectedVersion:0,value:'25',effectiveDate:'2026-11-01',comment:'Synthetic idempotent observation'},'flow-progress')).toEqual(progress);
      await expect(commands.transition(actor(),'objective',created.id,{...input,expectedVersion:99},'flow-close')).rejects.toMatchObject({code:'IDEMPOTENCY_KEY_REUSED'});
    }finally{spy.mockRestore();}
    expect(await evaluation.detail(actor(),'objective',created.id)).toMatchObject({state:'closed',progress:'25',evaluationStatus:'available'});
    expect(await admin.biProgressEntry.count({where:{keyResultId:child.id}})).toBe(1);
  });
  it('retains definitions and closes an automatic KPI with unavailable DW explicitly',async()=>{
    const created=await commands.create(actor(),'kpi',{title:'Synthetic automatic unavailable',ownerId:owner,from:'2026-11-01',to:'2026-11-30',metricId:'views',baseline:'0',target:'100',filters:{}},'automatic-create');
    await commands.transition(actor(),'kpi',created.id,{expectedVersion:0,action:'activate'},'automatic-activate');
    expect(await evaluation.detail(actor(),'kpi',created.id)).toMatchObject({evaluation:{current:{reason:'WAREHOUSE_UNAVAILABLE'},progress:null}});
    await commands.transition(actor(),'kpi',created.id,{expectedVersion:1,action:'close'},'automatic-close');
    expect(await evaluation.detail(actor(),'kpi',created.id)).toMatchObject({state:'closed',evaluation:{current:{reason:'WAREHOUSE_UNAVAILABLE'},progress:null}});
  });

  it('reads actual operational activity with tenant isolation, exact IDs and pagination',async()=>{
    const story=randomUUID(),foreignStory=randomUUID();
    await admin.$executeRaw`CREATE TABLE testimonials(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),author_name text NOT NULL,content text NOT NULL)`;
    await admin.$executeRaw`CREATE TABLE analytics_event_types(id int PRIMARY KEY,code text NOT NULL)`;
    await admin.$executeRaw`CREATE TABLE analytics_events(id bigint PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),testimonial_id uuid NOT NULL REFERENCES testimonials(id),event_type_id int NOT NULL REFERENCES analytics_event_types(id),source text NOT NULL,created_at timestamptz NOT NULL)`;
    await admin.$executeRaw`INSERT INTO testimonials VALUES(${story}::uuid,${tenant}::uuid,'Synthetic own','Synthetic observed content'),(${foreignStory}::uuid,${other}::uuid,'Synthetic foreign','Synthetic foreign content')`;
    await admin.$executeRaw`INSERT INTO analytics_event_types VALUES(1,'view'),(2,'click'),(3,'play')`;
    await admin.$executeRaw`INSERT INTO analytics_events SELECT 9007199254740993+i,${tenant}::uuid,${story}::uuid,(i%3)+1,CASE WHEN i%2=0 THEN 'widget' ELSE 'custom' END,statement_timestamp() FROM generate_series(0,21) i`;
    await admin.$executeRaw`INSERT INTO analytics_events VALUES(1,${other}::uuid,${foreignStory}::uuid,1,'widget',statement_timestamp())`;
    const activity=new ActivityRepository(admin as unknown as PrismaService);
    const page1=await activity.read(tenant,{});const page2=await activity.read(tenant,{page:'2'});
    expect(page1.meta.total).toBe(22);expect(page1.items).toHaveLength(20);expect(page2.items).toHaveLength(2);
    expect(page1.items.every(item=>item.testimonial.id===story)).toBe(true);expect(BigInt(page1.items[0]!.id)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect((await activity.read(tenant,{source:'other'})).meta.total).toBe(11);
    expect((await activity.read(other,{})).meta.total).toBe(1);
  });

});
