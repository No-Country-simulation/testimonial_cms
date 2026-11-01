import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir,userInfo} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
const exec=promisify(execFile);
const run=process.env.TEST_BI_GOVERNANCE_LOCAL==='true'?describe:describe.skip;
run('BI governance additive SQL on an owned PostgreSQL cluster',()=>{
  jest.setTimeout(60000);
  let root:string;let started=false;let admin:PrismaClient;
  const tenant=randomUUID(),other=randomUUID(),owner=randomUUID(),foreign=randomUUID(),objective=randomUUID(),result=randomUUID();
  beforeAll(async()=>{
    root=await mkdtemp(join(tmpdir(),'bi-governance-owned-'));
    await exec('initdb',['-D',join(root,'data'),'-A','trust','--no-locale','-E','UTF8']);
    await exec('pg_ctl',['-D',join(root,'data'),'-l',join(root,'postgres.log'),'-o',`-k ${root} -h '' -p 55440`,'-w','start']);started=true;
    const url=new URL(`postgresql://${userInfo().username}@localhost:55440/postgres`);url.searchParams.set('host',root);
    admin=new PrismaClient({datasources:{db:{url:url.toString()}},log:[]});
    // Minimal parent tables test declared BI FKs, not the full CMS/auth runtime.
    await admin.$executeRaw`CREATE TABLE tenants(id uuid PRIMARY KEY)`;
    await admin.$executeRaw`CREATE TABLE users(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),UNIQUE(tenant_id,id))`;
    await exec('psql',['-X','-v','ON_ERROR_STOP=1','-h',root,'-p','55440','-U',userInfo().username,'-d','postgres','-f',join(__dirname,'../prisma/migrations/20261101000000_bi_governance/migration.sql')]);
    await admin.$executeRaw`INSERT INTO tenants VALUES(${tenant}::uuid),(${other}::uuid)`;
    await admin.$executeRaw`INSERT INTO users VALUES(${owner}::uuid,${tenant}::uuid),(${foreign}::uuid,${other}::uuid)`;
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
});
