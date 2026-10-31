import { SourceRepository } from '../repositories/source.repository';
import { WarehouseRepository } from '../repositories/warehouse.repository';
import {
  EtlError,
  hourUtc,
  type EtlResult,
  type Lease,
  type SourceSnapshot,
} from '../etl.types';

export class EtlService {
  constructor(
    private readonly source: SourceRepository,
    private readonly warehouse: WarehouseRepository,
    private readonly observe?: (event: {
      phase: 'extraction' | 'publication';
      durationMs: number;
      status: 'succeeded';
      rows?: { categories: string; testimonials: string; events: string };
    }) => void,
  ) {}

  async *cycle(signal?: AbortSignal): AsyncGenerator<EtlResult> {
    let cursor: string | null = null;
    while (!signal?.aborted) {
      const ids = await this.source.tenantIds(cursor);
      if (!ids.length) return;
      for (const tenantId of ids) {
        if (signal?.aborted) return;
        try {
          yield await this.runTenant(tenantId, signal);
        } catch {
          yield { tenantId, status: 'failed', code: 'BI_ETL_FAILED' };
        }
      }
      cursor = ids.at(-1)!;
    }
  }

  async runTenant(
    tenantId: string,
    signal?: AbortSignal,
    origin: 'scheduled' | 'cli' = 'scheduled',
  ): Promise<EtlResult> {
    const commercial = (await this.source.commercialEligibility?.(
      tenantId,
    )) ?? { bi: true, statistics: true };
    if (!commercial.bi)
      return { tenantId, status: 'skipped', code: 'BI_BILLING_SUSPENDED' };
    let slot = hourUtc(new Date());
    let failure: EtlResult | undefined;
    // Persistent attempt limits survive restarts. This bound also prevents clock-skew loops.
    for (let attempt = 0; attempt < 3 && !signal?.aborted; attempt += 1) {
      const lease = this.warehouse.operations
        ? await this.warehouse.claim(tenantId, slot, origin)
        : await this.warehouse.claim(tenantId, slot);
      if (!lease) return failure ?? { tenantId, status: 'skipped' };
      // Graceful shutdown stops new claims; a managed active publication drains within its deadline.
      const outcome = await this.load(
        lease,
        this.warehouse.operations ? undefined : signal,
      );
      if (outcome.result.status === 'succeeded') return outcome.result;
      failure = outcome.result;
      if (outcome.result.code === 'BI_BILLING_SUSPENDED') return failure;
      if (
        this.warehouse.operations &&
        (origin === 'scheduled' || outcome.result.code === 'BI_SLOT_CHANGED')
      )
        return failure;
      slot = outcome.nextSlot ?? hourUtc(new Date());
    }
    return failure ?? { tenantId, status: 'skipped' };
  }

  private async load(
    lease: Lease,
    signal?: AbortSignal,
  ): Promise<{ result: EtlResult; nextSlot?: Date }> {
    let lost = false;
    let heartbeat: Promise<void> | undefined;
    let snapshot: SourceSnapshot | undefined;
    let nextSlot: Date | undefined;
    const check = () => {
      if (lost) throw new EtlError('BI_LEASE_LOST');
      if (signal?.aborted || Date.now() >= lease.deadline)
        throw new EtlError('BI_DEADLINE_EXCEEDED');
    };
    const timer = setInterval(() => {
      if (heartbeat) return;
      heartbeat = this.warehouse
        .heartbeat(lease)
        .then((live) => {
          if (!live) lost = true;
        })
        .catch(() => {
          lost = true;
        })
        .finally(() => {
          heartbeat = undefined;
        });
    }, 20000);
    const stop = async () => {
      clearInterval(timer);
      await heartbeat;
    };
    try {
      const extractionStarted = Date.now();
      const counts = await this.source.extract(
        lease.tenantId,
        {
          snapshot: async (value) => {
            check();
            if (value.tenantId !== lease.tenantId)
              throw new EtlError('BI_SOURCE_INCONSISTENT');
            if (hourUtc(value.at).getTime() !== lease.slot.getTime()) {
              nextSlot = hourUtc(value.at);
              throw new EtlError('BI_SLOT_CHANGED');
            }
            snapshot = value;
            await this.warehouse.snapshot(lease, value);
            check();
          },
          categories: async (rows) => {
            check();
            await this.warehouse.categories(lease, rows);
            check();
          },
          testimonials: async (rows) => {
            check();
            await this.warehouse.testimonials(lease, rows);
            check();
          },
          events: async (rows) => {
            check();
            await this.warehouse.events(lease, rows);
            check();
          },
          tags: async (rows) => {
            check();
            await this.warehouse.tags(lease, rows);
            check();
          },
          testimonialTags: async (rows) => {
            check();
            await this.warehouse.testimonialTags(lease, rows);
            check();
          },
        },
        lease.deadline,
      );
      this.observe?.({
        phase: 'extraction',
        durationMs: Date.now() - extractionStarted,
        status: 'succeeded',
        rows: {
          categories: counts.categories.toString(),
          testimonials: counts.testimonials.toString(),
          events: counts.events.toString(),
        },
      });
      await stop();
      check();
      if (!snapshot) throw new EtlError('BI_SOURCE_INCONSISTENT');
      await this.warehouse.extracted(lease, counts);
      check();
      const publicationStarted = Date.now();
      const commercial = (await this.source.commercialEligibility?.(
        lease.tenantId,
      )) ?? { bi: true, statistics: true };
      if (!commercial.bi) throw new EtlError('BI_BILLING_SUSPENDED');
      // Base taxonomy/history follows BI eligibility; statistical jobs have their own gate.
      await this.warehouse.publish(lease, snapshot, counts);
      this.observe?.({
        phase: 'publication',
        durationMs: Date.now() - publicationStarted,
        status: 'succeeded',
      });
      return {
        result: {
          tenantId: lease.tenantId,
          runId: lease.runId,
          status: 'succeeded',
        },
      };
    } catch (error) {
      await stop();
      // A lost connection after COMMIT is not proof of failure. Resolve durable outcome first.
      try {
        if ((await this.warehouse.status(lease)) === 'succeeded') {
          return {
            result: {
              tenantId: lease.tenantId,
              runId: lease.runId,
              status: 'succeeded',
            },
          };
        }
      } catch {
        /* Unreachable destination: leave lease/staging for fenced recovery. */
      }
      const code = error instanceof EtlError ? error.code : 'BI_ETL_FAILED';
      try {
        await this.warehouse.fail(lease, code);
      } catch {
        /* Recovery after lease expiry. */
      }
      const result: EtlResult = {
        tenantId: lease.tenantId,
        runId: lease.runId,
        status: 'failed',
        code,
      };
      return nextSlot ? { result, nextSlot } : { result };
    } finally {
      clearInterval(timer);
    }
  }
}
