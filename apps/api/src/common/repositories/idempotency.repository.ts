import { createHash, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApplicationError, InternalError } from '../errors/application.error';
import { PrismaService } from '../../modules/database/prisma.service';

const KEY_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;

type PrincipalKind = 'user' | 'api_key';

export interface IdempotencyRequest {
  key: string | undefined;
  tenantId: string;
  principalKind: PrincipalKind;
  principalId: string;
  method: 'POST';
  path: string;
  payload: unknown;
  statusCode: 200 | 201 | 202;
}

export interface IdempotencyResult<T> {
  value: T;
  replayed: boolean;
}

interface StoredResult {
  requestHash: string;
  recordState: string;
  statusCode: number | null;
  responseBody: Prisma.JsonValue | null;
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, field]) => field !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, field]) => [key, canonicalize(field)]),
    );
  }
  throw new ApplicationError('Invalid idempotency payload', 'invalid_input', 'IDEMPOTENCY_PAYLOAD_INVALID');
}

function sameHash(left:string,right:string):boolean {
  const a=Buffer.from(left);const b=Buffer.from(right);return a.length===b.length&&timingSafeEqual(a,b);
}

@Injectable()
export class IdempotencyRepository implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IdempotencyRepository.name);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => { void this.pruneExpired(); }, 60 * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async execute<T>(
    request: IdempotencyRequest,
    operation: (tx?: Prisma.TransactionClient) => Promise<T>,
  ): Promise<IdempotencyResult<T>> {
    if (request.key === undefined) {
      return { value: await operation(), replayed: false };
    }
    if (!KEY_PATTERN.test(request.key)) {
      throw new ApplicationError('Invalid Idempotency-Key', 'invalid_input', 'IDEMPOTENCY_KEY_INVALID');
    }

    const key = request.key;
    const hash = createHash('sha256')
      .update(JSON.stringify(canonicalize(request.payload)))
      .digest('hex');
    const { tenantId, principalKind, principalId, method, path } = request;

    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
        await tx.$executeRaw`
          DELETE FROM "idempotency_keys"
          WHERE "tenant_id" = ${tenantId}::uuid AND "principal_kind" = ${principalKind}
            AND "principal_id" = ${principalId} AND "method" = ${method}
            AND "path" = ${path} AND "key" = ${key} AND "expires_at" <= now()
        `;
        const inserted = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO "idempotency_keys"
            ("id", "key", "tenant_id", "principal_kind", "principal_id", "method", "path",
             "request_hash", "record_state", "status_code", "response_body", "expires_at",
             "created_at", "updated_at")
          VALUES (gen_random_uuid(), ${key}, ${tenantId}::uuid, ${principalKind}, ${principalId},
                  ${method}, ${path}, ${hash}, 'pending', NULL, NULL,
                  now() + interval '24 hours', now(), now())
          ON CONFLICT ("tenant_id", "principal_kind", "principal_id", "method", "path", "key")
          DO NOTHING RETURNING "id"
        `;
        await tx.$executeRaw`SET LOCAL lock_timeout = 0`;

        if (inserted.length === 0) {
          const rows = await tx.$queryRaw<StoredResult[]>`
            SELECT "request_hash" AS "requestHash", "record_state" AS "recordState",
                   "status_code" AS "statusCode", "response_body" AS "responseBody"
            FROM "idempotency_keys"
            WHERE "tenant_id" = ${tenantId}::uuid AND "principal_kind" = ${principalKind}
              AND "principal_id" = ${principalId} AND "method" = ${method}
              AND "path" = ${path} AND "key" = ${key}
          `;
          const existing = rows[0];
          if (!existing) throw new InternalError('Idempotency result unavailable');
          if (!sameHash(existing.requestHash,hash)) {
            throw new ApplicationError('Idempotency-Key belongs to another request', 'conflict', 'IDEMPOTENCY_KEY_REUSED');
          }
          if (existing.recordState !== 'completed' || existing.statusCode === null || existing.responseBody === null) {
            throw new ApplicationError('Idempotent request is still in progress', 'conflict', 'IDEMPOTENCY_IN_PROGRESS');
          }
          return { value: existing.responseBody as T, replayed: true };
        }

        const value = await operation(tx);
        const responseBody = JSON.stringify(value);
        if (responseBody === undefined) throw new InternalError('Idempotent response is not JSON');
        await tx.$executeRaw`
          UPDATE "idempotency_keys" SET "record_state" = 'completed',
            "status_code" = ${request.statusCode}, "response_body" = ${responseBody}::jsonb,
            "updated_at" = now()
          WHERE "id" = ${inserted[0]!.id}::uuid
        `;
        return { value, replayed: false };
      }, { timeout: 10_000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError
        && error.code === 'P2010' && error.meta?.code === '55P03') {
        throw new ApplicationError('Idempotent request is still in progress', 'conflict', 'IDEMPOTENCY_IN_PROGRESS');
      }
      throw error;
    }
  }

  /** Prepare cross-database reads outside the OLTP transaction; completed retries never prepare again. */
  async executePrepared<T,P>(request:IdempotencyRequest,prepare:()=>Promise<P>,operation:(prepared:P,tx?:Prisma.TransactionClient)=>Promise<T>):Promise<IdempotencyResult<T>> {
    const prior=await this.completed<T>(request);if(prior)return prior;
    let prepared:P;
    try{prepared=await prepare();}
    catch(error){const replay=await this.completed<T>(request);if(replay)return replay;throw error;}
    return this.execute(request,tx=>operation(prepared,tx));
  }
  private async completed<T>(request:IdempotencyRequest):Promise<IdempotencyResult<T>|undefined> {
    if(request.key===undefined)return undefined;
    if(!KEY_PATTERN.test(request.key))throw new ApplicationError('Invalid Idempotency-Key','invalid_input','IDEMPOTENCY_KEY_INVALID');
    const hash=createHash('sha256').update(JSON.stringify(canonicalize(request.payload))).digest('hex');
    const rows=await this.prisma.$queryRaw<StoredResult[]>`SELECT request_hash AS "requestHash",record_state AS "recordState",status_code AS "statusCode",response_body AS "responseBody"
      FROM idempotency_keys WHERE tenant_id=${request.tenantId}::uuid AND principal_kind=${request.principalKind} AND principal_id=${request.principalId}
      AND method=${request.method} AND path=${request.path} AND key=${request.key} AND expires_at>now()`;
    const row=rows[0];if(!row)return undefined;
    if(!sameHash(row.requestHash,hash))throw new ApplicationError('Idempotency-Key belongs to another request','conflict','IDEMPOTENCY_KEY_REUSED');
    if(row.recordState==='completed'&&row.statusCode!==null&&row.responseBody!==null)return {value:row.responseBody as T,replayed:true};
    return undefined;
  }

  private async pruneExpired(): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        WITH expired AS (
          SELECT "id" FROM "idempotency_keys"
          WHERE "expires_at" <= now()
          ORDER BY "expires_at" LIMIT 1000 FOR UPDATE SKIP LOCKED
        )
        DELETE FROM "idempotency_keys" WHERE "id" IN (SELECT "id" FROM expired)
      `;
    } catch {
      this.logger.warn('Expired idempotency rows could not be pruned');
    }
  }
}
