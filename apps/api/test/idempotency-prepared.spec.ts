import {createHash} from 'node:crypto';
import {IdempotencyRepository,type IdempotencyRequest} from '../src/common/repositories/idempotency.repository';
const request:IdempotencyRequest={key:'synthetic-key',tenantId:'tenant',principalKind:'user',principalId:'actor',method:'POST',path:'/api/v1/bi/objectives/id/transitions',payload:{action:'close',expectedVersion:1},statusCode:200};
const hash=createHash('sha256').update(JSON.stringify({action:'close',expectedVersion:1})).digest('hex');
const completed={requestHash:hash,recordState:'completed',statusCode:200,responseBody:{id:'goal',state:'closed',version:2}};
describe('idempotency with outside-transaction preparation',()=>{
  it('recovers an existing close without consulting DW or opening a transaction',async()=>{
    const prisma={$queryRaw:jest.fn().mockResolvedValue([completed]),$transaction:jest.fn()};
    const repo=new IdempotencyRepository(prisma as never);const prepare=jest.fn();const operation=jest.fn();
    expect(await repo.executePrepared(request,prepare,operation)).toEqual({value:completed.responseBody,replayed:true});
    expect(prepare).not.toHaveBeenCalled();expect(prisma.$transaction).not.toHaveBeenCalled();expect(operation).not.toHaveBeenCalled();
  });
  it('prepares first and delegates only the mutation to the existing transaction protocol',async()=>{
    const repo=new IdempotencyRepository({$queryRaw:jest.fn().mockResolvedValue([])} as never);
    let active=false;
    jest.spyOn(repo,'execute').mockImplementation(async(_request,operation)=>{active=true;try{return {value:await operation({} as never),replayed:false};}finally{active=false;}});
    const prepare=jest.fn(async()=>{expect(active).toBe(false);return {value:'evaluated'};});
    const operation=jest.fn(async(prepared)=>{expect(active).toBe(true);return prepared;});
    expect(await repo.executePrepared(request,prepare,operation)).toEqual({value:{value:'evaluated'},replayed:false});
  });
  it('rejects changed payloads before preparing an evaluation',async()=>{
    const repo=new IdempotencyRepository({$queryRaw:jest.fn().mockResolvedValue([{...completed,requestHash:'0'.repeat(64)}])} as never);
    const prepare=jest.fn();await expect(repo.executePrepared(request,prepare,jest.fn())).rejects.toMatchObject({code:'IDEMPOTENCY_KEY_REUSED'});expect(prepare).not.toHaveBeenCalled();
  });
  it('recovers a concurrent completed result if preparation fails',async()=>{
    const query=jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([completed]);
    const repo=new IdempotencyRepository({$queryRaw:query} as never);
    expect(await repo.executePrepared(request,async()=>{throw new Error('DW failed');},jest.fn())).toEqual({value:completed.responseBody,replayed:true});
  });
});
