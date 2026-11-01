import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir,userInfo} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Prisma,PrismaClient} from '@prisma/client';
import {installBiWarehouse} from './fixtures/bi-warehouse';
import {applyWarehouseMigration} from '../src/modules/business-intelligence/repositories/warehouse-migrations';
import {WarehouseRepository} from '../src/modules/business-intelligence/repositories/warehouse.repository';
import {BiConnection} from '../src/modules/business-intelligence/repositories/bi-connection';
import {AnalyticalReadService} from '../src/modules/business-intelligence/services/analytical-read.service';
import {ExplorationRepository} from '../src/modules/business-intelligence/repositories/exploration.repository';
import {PeriodMeasurementsRepository} from '../src/modules/business-intelligence/repositories/period-measurements.repository';
import {hourUtc} from '../src/modules/business-intelligence/etl.types';
const exec=promisify(execFile);
const run=process.env.TEST_BI_UNIFIED_LOCAL==='true'?describe:describe.skip;
run('unified BI on an owned disposable PostgreSQL 18 cluster',()=>{
  jest.setTimeout(60000);
  let root:string;let started=false;let admin:PrismaClient;let read:PrismaClient;let connection:BiConnection;
  let explore:ExplorationRepository;let periods:PeriodMeasurementsRepository;
  const a=randomUUID(),b=randomUUID(),legacy=randomUUID(),cat=randomUUID(),t1=randomUUID(),t2=randomUUID(),tag1=randomUUID(),tag2=randomUUID();
  const query={from:'2026-10-01',to:'2026-10-03'};
  const reader='bi_unified_reader';
  const client=(url:string)=>new PrismaClient({datasources:{db:{url}},log:[]});
  async function load(tenantId:string,at:string,empty=false,legacyCut=false) {
    const warehouse=new WarehouseRepository(admin,!legacyCut);
    const lease=await warehouse.claim(tenantId,hourUtc(new Date(at)));
    if(!lease) throw new Error('OWNED_FIXTURE_CLAIM_FAILED');
    const snapshot={tenantId,name:'Synthetic fixture',isActive:true,at:new Date(at)};
    await warehouse.snapshot(lease,snapshot);
    await warehouse.categories(lease,[{tenantId,categoryId:cat,name:'Synthetic category'}]);
    const rows=empty?[]:[t1,t2].map((id,index)=>({tenantId,testimonialId:id,categoryId:index===0?cat:null,statusCode:index===0?'published':'rejected',rating:at.startsWith('2026-10-03')?(index===0?4:2):(index===0?5:1),score:new Prisma.Decimal(0),createdAt:new Date('2026-10-01Z'),publishedAt:null,hasImage:false,hasVideo:false}));
    await warehouse.testimonials(lease,rows);
    if(!legacyCut) await warehouse.tags(lease,[{tenantId,tagId:tag1,name:'Synthetic A'},{tenantId,tagId:tag2,name:'Synthetic B'}]);
    const links=empty?[]:[{tenantId,testimonialId:t1,tagId:tag1},{tenantId,testimonialId:t1,tagId:tag2},{tenantId,testimonialId:t2,tagId:tag1}];
    if(!legacyCut) await warehouse.testimonialTags(lease,links);
    const events=empty?[]:Array.from({length:5},(_,index)=>({tenantId,eventId:BigInt(index+1),testimonialId:index<3?t1:t2,eventTypeCode:index<2?'view':'click',sourceCode:'widget' as const,createdAt:new Date('2026-10-01T12:00:00Z')}));
    await warehouse.events(lease,events);
    const counts={categories:1n,testimonials:BigInt(rows.length),events:BigInt(events.length),...(!legacyCut?{taxonomy:{tags:2n,relations:BigInt(links.length)}}:{})};
    await warehouse.extracted(lease,counts);await warehouse.publish(lease,snapshot,counts);
  }
  beforeAll(async()=>{
    root=await mkdtemp(join(tmpdir(),'bi-unified-owned-'));
    await exec('initdb',['-D',join(root,'data'),'-A','trust','--no-locale','-E','UTF8']);
    await exec('pg_ctl',['-D',join(root,'data'),'-l',join(root,'postgres.log'),'-o',`-k ${root} -h '' -p 55439`,'-w','start']);started=true;
    const url=new URL(`postgresql://${userInfo().username}@localhost:55439/postgres`);url.searchParams.set('host',root);
    admin=client(url.toString());await installBiWarehouse(admin);
    for(const version of ['0004_bi_operations.sql','0005_bi_statistics.sql']) {
      // Fixed migration basenames and repository directory; never user-controlled.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const sql=await readFile(join(__dirname,'../warehouse/migrations',version),'utf8');await applyWarehouseMigration(admin,version,sql);
    }
    await load(a,'2026-10-01T23:00:00Z');await load(a,'2026-10-03T23:00:00Z');await load(b,'2026-10-03T23:00:00Z',true);await load(legacy,'2026-10-03T23:00:00Z',false,true);
    await admin.$executeRawUnsafe(`CREATE ROLE ${reader} LOGIN`);
    await admin.$executeRawUnsafe(`GRANT USAGE ON SCHEMA dw TO ${reader}`);
    await admin.$executeRawUnsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA dw TO ${reader}`);
    url.username=reader;read=client(url.toString());
    const saved={enabled:process.env.BI_ENABLED,url:process.env.BI_DATABASE_URL};
    try{process.env.BI_ENABLED='true';process.env.BI_DATABASE_URL=url.toString();connection=new BiConnection();}
    finally{if(saved.enabled===undefined)delete process.env.BI_ENABLED;else process.env.BI_ENABLED=saved.enabled;if(saved.url===undefined)delete process.env.BI_DATABASE_URL;else process.env.BI_DATABASE_URL=saved.url;}
    explore=new ExplorationRepository(connection);periods=new PeriodMeasurementsRepository(connection);
  });
  afterAll(async()=>{
    await connection?.onModuleDestroy();await read?.$disconnect();await admin?.$disconnect();
    if(started) await exec('pg_ctl',['-D',join(root,'data'),'-m','immediate','-w','stop']);
    if(root)await rm(root,{recursive:true,force:true});
  });
  it('executes actual period SQL with exact independent totals',async()=>{
    const result=await periods.read(a,query);
    expect(result.current.metrics.inventory_total).toMatchObject({value:'2'});
    expect(result.current.metrics.average_rating).toMatchObject({value:'3'});
    expect(result.current.metrics.ctr).toMatchObject({value:'150'});
    expect(result.current.metrics.tagged_share).toMatchObject({value:'100'});
    expect(result.current.metrics.observed_creations).toMatchObject({value:'2'});
  });
  it('does not multiply two selected tags and classifies engagement by closing cohort',async()=>{
    const result=await periods.read(a,{...query,tagId:[tag1,tag2],categoryId:cat});
    expect(result.current.metrics.inventory_total).toMatchObject({value:'1'});expect(result.current.metrics.views).toMatchObject({value:'2'});expect(result.current.metrics.clicks).toMatchObject({value:'1'});
  });
  it('executes breakdowns, grouping and ranking under a DW-only reader',async()=>{
    const result=await explore.breakdowns(a,query);
    expect(result.categories.totalGroups).toBe('2');expect(result.tags.items.find(x=>x.id===tag1)?.count).toMatchObject({value:'2'});
    expect(result.ranking.items).toHaveLength(2);expect(result.ranking.items[0]?.testimonialId).toBe(t1);
    expect(result.sources[0]?.ctr).toMatchObject({value:'150'});
  });
  it('preserves a missing daily cut while retaining recorded event zeros',async()=>{
    const result=await explore.daily(a,query);
    expect(result.items).toHaveLength(3);expect(result.items[1]?.metrics.inventory_total).toMatchObject({reason:'NO_CUT'});
    expect(result.items[1]?.metrics.views).toMatchObject({value:'0'});expect(result.items[0]?.metrics.tagged_share).toMatchObject({value:'100'});
  });
  it('executes option queries with literal wildcard text and empty-page totals',async()=>{
    expect((await explore.filterOptions(a,{...query,dimension:'tag'})).items).toHaveLength(2);
    expect((await explore.filterOptions(a,{...query,dimension:'category',q:'%'})).items).toHaveLength(0);
    expect((await explore.filterOptions(a,{...query,dimension:'tag',page:'2'})).meta.total).toBe(2);
  });
  it('isolates tenant facts and rejects writes/control access at SQL level',async()=>{
    expect((await periods.read(b,query)).current.metrics.inventory_total).toMatchObject({value:'0'});
    expect((await explore.breakdowns(b,query)).ranking.items).toHaveLength(0);
    await expect(read.$executeRaw`DELETE FROM dw.dim_tag`).rejects.toMatchObject({code:'P2010',meta:{code:'42501'}});
    await expect(read.$queryRaw`SELECT * FROM etl.statistics_jobs`).rejects.toMatchObject({code:'P2010',meta:{code:'42501'}});
    await expect(read.$executeRaw`CREATE TABLE dw.forbidden(id int)`).rejects.toMatchObject({code:'P2010',meta:{code:'42501'}});
  });
  it('uses the historical closing cut rather than current testimonial attributes',async()=>{
    expect((await periods.read(a,{from:'2026-10-01',to:'2026-10-01',categoryId:cat})).current.metrics.average_rating).toMatchObject({value:'5'});
    expect((await periods.read(a,{...query,categoryId:cat})).current.metrics.average_rating).toMatchObject({value:'4'});
  });
  it('filters uncategorized testimonials and keeps sources out of inventory',async()=>{
    const uncategorized=await periods.read(a,{...query,categoryId:'none'});
    expect(uncategorized.current.metrics.inventory_total).toMatchObject({value:'1'});
    expect(uncategorized.current.metrics.clicks).toMatchObject({value:'2'});
    const noEvents=await periods.read(a,{...query,source:'api'});
    expect(noEvents.current.metrics.inventory_total).toMatchObject({value:'2'});
    expect(noEvents.current.metrics.views).toMatchObject({value:'0'});
    expect(noEvents.current.metrics.ctr).toMatchObject({reason:'ZERO_DENOMINATOR'});
  });
  it('preserves exact large event totals through PostgreSQL and serialization',async()=>{
    await admin.$executeRaw`UPDATE dw.fact_engagement_daily SET event_count=9007199254740993 WHERE tenant_id=${a}::uuid
      AND event_type_key=(SELECT event_type_key FROM dw.dim_event_type WHERE code='view')`;
    try {expect((await periods.read(a,query)).current.metrics.views).toMatchObject({value:'9007199254740993'});}
    finally {await admin.$executeRaw`UPDATE dw.fact_engagement_daily SET event_count=2 WHERE tenant_id=${a}::uuid
      AND event_type_key=(SELECT event_type_key FROM dw.dim_event_type WHERE code='view')`;}
  });
  it('measures bounded 365-day exploration with observed sparse history',async()=>{
    const largeRange={from:'2025-11-01',to:'2026-10-31'};
    const samples:number[]=[];
    for(let i=0;i<5;i++){
      const start=performance.now();
      const daily=await explore.daily(a,largeRange);expect(daily.items).toHaveLength(365);
      await explore.breakdowns(a,largeRange);await explore.filterOptions(a,{...largeRange,dimension:'tag'});
      samples.push(performance.now()-start);
    }
    console.info(JSON.stringify({event:'bi.unified_local_read_benchmark',tenantCount:3,testimonialSnapshots:6,events:10,days:365,
      samplesMs:samples.map(x=>Math.round(x)),scope:'synthetic_small_sparse_not_capacity'}));
  });

  it('does not invent historical tag observation on a legacy cut',async()=>{
    const unfiltered=await periods.read(legacy,query);
    expect(unfiltered.current.metrics.inventory_total).toMatchObject({value:'2'});
    expect(unfiltered.current.metrics.tagged_share).toMatchObject({reason:'TAGS_NOT_OBSERVED'});
    expect((await periods.read(legacy,{...query,tagId:'none'})).current.metrics.inventory_total).toMatchObject({reason:'TAGS_NOT_OBSERVED'});
    expect((await explore.filterOptions(legacy,{...query,dimension:'tag'})).meta.availability).toBe('TAGS_NOT_OBSERVED');
  });

  it('composes an overview from one DW snapshot with explicit previous-period gaps',async()=>{
    const service=new AnalyticalReadService(explore,{settings:async()=>({frequencyHours:1,delayToleranceMinutes:60})} as never);
    const overview=await service.overview(a,query);
    expect(overview).toMatchObject({contractVersion:'bi_overview_v1',metrics:{inventory_total:{value:'2'}},previous:{metrics:{inventory_total:{reason:'NO_CUT'}}}});
    expect(overview.daily).toHaveLength(3);expect(overview.provenance.closingCut?.snapshotAt).toBe('2026-10-03T23:00:00.000Z');
    expect((await service.breakdowns(a,query)).provenance.tagsAtClosingCut).toBe('observed');
  });

  it('rejects unknown category and tag IDs without treating them as a zero cohort',async()=>{
    await expect(periods.read(a,{...query,categoryId:randomUUID()})).rejects.toMatchObject({code:'BI_FILTER_INVALID'});
    await expect(periods.read(a,{...query,tagId:randomUUID()})).rejects.toMatchObject({code:'BI_FILTER_INVALID'});
  });

});
