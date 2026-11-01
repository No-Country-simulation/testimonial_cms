import {Test} from '@nestjs/testing';
import {ConfigService} from '@nestjs/config';
import {JwtService} from '@nestjs/jwt';
import {Reflector} from '@nestjs/core';
import {Global,Module,type INestApplication} from '@nestjs/common';
import {BusinessIntelligenceModule} from '../src/modules/business-intelligence/business-intelligence.module';
import {PeriodMeasurementsRepository} from '../src/modules/business-intelligence/repositories/period-measurements.repository';
import {PrismaService} from '../src/modules/database/prisma.service';
import {BillingAccessRepository} from '../src/modules/billing/access';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import type {Request,Response,NextFunction} from 'express';
import {ZodValidationPipe} from 'nestjs-zod';
import {BiGovernanceController} from '../src/modules/business-intelligence/controllers/bi-governance.controller';
import {BiAnalyticalController} from '../src/modules/business-intelligence/controllers/bi-analytical.controller';
import {GovernanceCommandService} from '../src/modules/business-intelligence/services/governance-command.service';
import {GovernanceEvaluationService} from '../src/modules/business-intelligence/services/governance-evaluation.service';
import {GovernanceRepository} from '../src/modules/business-intelligence/repositories/governance.repository';
import {ActivityRepository} from '../src/modules/business-intelligence/repositories/activity.repository';
import {AnalyticalReadService} from '../src/modules/business-intelligence/services/analytical-read.service';
import {IdempotencyService} from '../src/common/services/idempotency.service';
import {CredentialRepository} from '../src/common/repositories/credential.repository';
import {RateLimitService} from '../src/common/services/rate-limit.service';
import {CsrfGuard} from '../src/common/guards/csrf.guard';
import {SessionCsrfService} from '../src/common/services/session-csrf.service';
import {ApiExceptionFilter} from '../src/common/filters/api-exception.filter';
import {ApiResponseInterceptor} from '../src/common/interceptors/api-response.interceptor';
import {RateLimitedError} from '../src/common/errors/application.error';
import {BiPrivateMiddleware} from '../src/modules/business-intelligence/guards/bi-private.middleware';
const tenant='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',owner='33333333-3333-4333-8333-333333333333';
describe('unified BI HTTP guards and wire contracts (domain stores simulated)',()=>{
  let app:INestApplication;let adminToken:string;let editorToken:string;let otherToken:string;
  const secret='synthetic-bi-governance-http-secret-key';
  const goals={createObjective:jest.fn(async()=>({id:owner,state:'draft',version:0})),createKpi:jest.fn(async()=>({id:owner,state:'draft',version:0})),progressHistory:jest.fn()};
  const evaluations={read:jest.fn(async()=>({items:[],meta:{total:0,page:1,limit:20}})),detail:jest.fn(),capture:jest.fn()};
  const analytical={overview:jest.fn(),breakdowns:jest.fn(),filterOptions:jest.fn()};
  const activity={read:jest.fn(async()=>({items:[],meta:{total:0,page:1,limit:20,source:'operational'}}))};
  const quota={assertWithinLimit:jest.fn(async()=>undefined)};
  const idem={execute:jest.fn(async(_request,operation)=>({value:await operation({}),replayed:false})),executePrepared:jest.fn(async(_request,prepare,operation)=>({value:await operation(await prepare(),{}),replayed:false}))};
  const config={getOrThrow:()=>({jwt:{secret},corsOrigin:'http://fixture.test'})};
  beforeAll(async()=>{
    const module=await Test.createTestingModule({controllers:[BiGovernanceController,BiAnalyticalController],providers:[GovernanceCommandService,JwtService,Reflector,SessionCsrfService,
      {provide:ConfigService,useValue:config},{provide:CredentialRepository,useValue:{findActiveUser:async(id:string)=>({userId:id,tenantId:id==='foreign'?other:tenant,roles:[id==='editor'?'editor':'admin'],isActive:true,email:'synthetic@example.test',tenantName:'Synthetic'})}},
      {provide:PeriodMeasurementsRepository,useValue:{validateScope:async()=>undefined}},{provide:GovernanceRepository,useValue:goals},{provide:GovernanceEvaluationService,useValue:evaluations},{provide:IdempotencyService,useValue:idem},
      {provide:AnalyticalReadService,useValue:analytical},{provide:ActivityRepository,useValue:activity},{provide:RateLimitService,useValue:quota},
    ]}).compile();
    app=module.createNestApplication();app.setGlobalPrefix('api/v1');app.use(cookieParser());
    const privacy=new BiPrivateMiddleware();app.use((req:Request,res:Response,next:NextFunction)=>privacy.use(req,res,next));
    app.useGlobalGuards(new CsrfGuard(app.get(Reflector),app.get(ConfigService),app.get(SessionCsrfService)));
    app.useGlobalPipes(new ZodValidationPipe());app.useGlobalFilters(new ApiExceptionFilter());app.useGlobalInterceptors(new ApiResponseInterceptor());await app.init();await app.listen(0,'127.0.0.1');
    const jwt=app.get(JwtService);adminToken=jwt.sign({sub:'admin',tenantId:tenant},{secret});editorToken=jwt.sign({sub:'editor',tenantId:tenant},{secret});otherToken=jwt.sign({sub:'foreign',tenantId:other},{secret});
  });
  beforeEach(()=>jest.clearAllMocks());afterAll(async()=>app?.close());
  const definition={title:'Synthetic objective',ownerId:owner,from:'2026-11-01',to:'2026-11-30'};
  it('requires JWT, returns private errors, and permits editor reads',async()=>{
    const denied=await request(app.getHttpServer()).get('/api/v1/bi/kpis').expect(401);expect(denied.headers['cache-control']).toBe('private, no-store');
    const result=await request(app.getHttpServer()).get('/api/v1/bi/objectives').auth(editorToken,{type:'bearer'}).expect(200);
    expect(result.body).toMatchObject({success:true,data:[],meta:{page:1,total:0}});
  });
  it('serves the catalog without asking the warehouse and rejects query injection',async()=>{
    const result=await request(app.getHttpServer()).get('/api/v1/bi/metric-catalog').auth(editorToken,{type:'bearer'}).expect(200);expect(result.body.data.metrics).toHaveLength(16);
    await request(app.getHttpServer()).get('/api/v1/bi/kpis?tenantId=forged').auth(adminToken,{type:'bearer'}).expect(400);expect(evaluations.read).not.toHaveBeenCalled();
  });
  it('denies editor creation and requires idempotency before any store mutation',async()=>{
    await request(app.getHttpServer()).post('/api/v1/bi/objectives').auth(editorToken,{type:'bearer'}).send(definition).expect(403);
    await request(app.getHttpServer()).post('/api/v1/bi/objectives').auth(adminToken,{type:'bearer'}).send(definition).expect(400);
    expect(goals.createObjective).not.toHaveBeenCalled();expect(idem.execute).not.toHaveBeenCalled();
  });
  it('validates nested definitions and ignores forged tenant headers',async()=>{
    await request(app.getHttpServer()).post('/api/v1/bi/objectives').auth(adminToken,{type:'bearer'}).set('idempotency-key','synthetic-key').send({...definition,tenantId:other}).expect(400);
    const created=await request(app.getHttpServer()).post('/api/v1/bi/objectives').auth(otherToken,{type:'bearer'}).set('x-tenant-id',tenant).set('idempotency-key','synthetic-key').send(definition).expect(201);
    expect(created.body.data).toEqual({id:owner,state:'draft',version:0});expect(goals.createObjective).toHaveBeenCalledWith(expect.objectContaining({tenantId:other}),expect.objectContaining(definition),expect.anything());
    expect(quota.assertWithinLimit).toHaveBeenCalledWith(expect.any(Array),20,60,expect.any(String));
  });
  it('checks actual CSRF HMAC and Origin on cookie-authenticated mutations',async()=>{
    const cookies=[`accessToken=${adminToken}`,'refreshToken=synthetic-refresh'];
    await request(app.getHttpServer()).post('/api/v1/bi/objectives').set('Cookie',cookies).set('Origin','http://fixture.test').set('idempotency-key','synthetic-cookie').send(definition).expect(403);
    const token=app.get(SessionCsrfService).tokenFor('synthetic-refresh');
    await request(app.getHttpServer()).post('/api/v1/bi/objectives').set('Cookie',cookies).set('Origin','http://foreign.test').set('x-csrf-token',token).set('idempotency-key','synthetic-cookie').send(definition).expect(403);
    await request(app.getHttpServer()).post('/api/v1/bi/objectives').set('Cookie',cookies).set('Origin','http://fixture.test').set('x-csrf-token',token).set('idempotency-key','synthetic-cookie').send(definition).expect(201);
  });
  it('uses the session tenant for operational activity and rejects inventory filters there',async()=>{
    await request(app.getHttpServer()).get('/api/v1/bi/activity?categoryId=none').auth(adminToken,{type:'bearer'}).expect(400);
    await request(app.getHttpServer()).get('/api/v1/bi/activity?source=widget').auth(otherToken,{type:'bearer'}).expect(200);
    expect(activity.read).toHaveBeenCalledWith(other,expect.objectContaining({source:['widget']}));expect(analytical.overview).not.toHaveBeenCalled();
  });
  it('rejects malformed UUIDs, capture injection and exhausted request quotas',async()=>{
    await request(app.getHttpServer()).get('/api/v1/bi/objectives/not-a-uuid').auth(adminToken,{type:'bearer'}).expect(400);
    await request(app.getHttpServer()).post(`/api/v1/bi/objectives/${owner}/transitions`).auth(adminToken,{type:'bearer'}).set('idempotency-key','synthetic-key').send({expectedVersion:0,action:'close',capture:{progress:'100'}}).expect(400);
    quota.assertWithinLimit.mockRejectedValueOnce(new RateLimitedError('Synthetic quota'));
    await request(app.getHttpServer()).get('/api/v1/bi/kpis').auth(adminToken,{type:'bearer'}).expect(429);
  });
  it('composes the real BI module without querying governance tables at startup',async()=>{
    const sql=jest.fn();
    @Global()
    @Module({providers:[JwtService,{provide:ConfigService,useValue:config},{provide:CredentialRepository,useValue:{}},
      {provide:RateLimitService,useValue:quota},{provide:PrismaService,useValue:{$queryRaw:sql,$transaction:sql}},
      {provide:BillingAccessRepository,useValue:{checkMutation:jest.fn()}},{provide:IdempotencyService,useValue:idem}],
      exports:[JwtService,ConfigService,CredentialRepository,RateLimitService,PrismaService,BillingAccessRepository,IdempotencyService]})
    class Globals {}
    const module=await Test.createTestingModule({imports:[Globals,BusinessIntelligenceModule]}).compile();
    const isolated=module.createNestApplication();
    try{await isolated.init();expect(isolated.get(BiGovernanceController)).toBeDefined();expect(isolated.get(BiAnalyticalController)).toBeDefined();expect(sql).not.toHaveBeenCalled();}
    finally{await isolated.close();}
  });

});
