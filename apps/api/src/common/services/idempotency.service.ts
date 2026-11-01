import { Injectable } from '@nestjs/common';
import { IdempotencyRepository, type IdempotencyRequest, type IdempotencyResult } from '../repositories/idempotency.repository';
import type { TransactionClient } from '../repositories/transaction-client';

export type { IdempotencyRequest, IdempotencyResult } from '../repositories/idempotency.repository';

@Injectable()
export class IdempotencyService {
  constructor(private readonly repository: IdempotencyRepository) {}

  execute<T>(request: IdempotencyRequest, operation: (tx?: TransactionClient) => Promise<T>): Promise<IdempotencyResult<T>> {
    return this.repository.execute(request, operation);
  }
  executePrepared<T,P>(request:IdempotencyRequest,prepare:()=>Promise<P>,operation:(prepared:P,tx?:TransactionClient)=>Promise<T>):Promise<IdempotencyResult<T>> {
    return this.repository.executePrepared(request,prepare,operation);
  }

}
