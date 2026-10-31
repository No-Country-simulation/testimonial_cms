import { etlConfig } from '../src/modules/business-intelligence/etl.config';
import { EtlError, hourUtc } from '../src/modules/business-intelligence/etl.types';
import { migrationStatements } from '../src/modules/business-intelligence/repositories/warehouse-migrations';
import { EtlService } from '../src/modules/business-intelligence/services/etl.service';
import { ScoringService } from '../src/modules/testimonials/services/scoring.service';
import { main as migrate } from '../src/modules/business-intelligence/migration.cli';

describe('independent ETL configuration and UTC', () => {
  it('requires an explicit apply argument before the standalone migrator can connect', async () => {
    await expect(migrate([])).rejects.toMatchObject({ code: 'BI_CONFIGURATION_INVALID' });
    await expect(migrate(['--once'])).rejects.toMatchObject({ code: 'BI_CONFIGURATION_INVALID' });
  });
  it('requires distinct explicit connections and caps their pools', () => {
    expect(() => etlConfig({ DATABASE_URL: 'postgresql://existing/db' })).toThrow('BI_CONFIGURATION_INVALID');
    expect(() => etlConfig({ BI_SOURCE_DATABASE_URL: 'https://wrong/db', BI_ETL_DATABASE_URL: 'postgresql://target/dw' })).toThrow();
    expect(() => etlConfig({ NODE_ENV: 'production', BI_SOURCE_DATABASE_URL: 'postgresql://same/oltp',
      BI_ETL_DATABASE_URL: 'postgresql://same:5432/dw' })).toThrow();
    const config = etlConfig({ BI_SOURCE_DATABASE_URL: 'postgresql://source/oltp?connection_limit=100',
      BI_ETL_DATABASE_URL: 'postgresql://target/dw' });
    expect(new URL(config.sourceUrl).searchParams.get('connection_limit')).toBe('1');
    expect(new URL(config.warehouseUrl).searchParams.get('connection_limit')).toBe('2');
  });
  it('never includes an invalid connection string in an error', () => {
    try { etlConfig({ BI_SOURCE_DATABASE_URL: 'invalid-private-value' }); }
    catch (error) { expect(String(error)).not.toContain('invalid-private-value'); }
  });
  it('uses real UTC hours across leap days and year boundaries', () => {
    expect(hourUtc(new Date('2024-03-01T02:59:59.999+03:00')).toISOString()).toBe('2024-02-29T23:00:00.000Z');
    expect(hourUtc(new Date('2027-01-01T00:59:59.999Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
  it('keeps quoted semicolons and discards comments without breaking initial DDL', () => {
    expect(migrationStatements("-- a comment;\nBEGIN; INSERT INTO x VALUES ('a;''b'); COMMIT;"))
      .toEqual(["INSERT INTO x VALUES ('a;''b')"]);
    expect(() => migrationStatements("SELECT 'unfinished;")).toThrow();
    expect(() => migrationStatements('CREATE FUNCTION x() AS $$x$$;')).toThrow();
  });
});

describe('ETL lifecycle', () => {
  const lease = { tenantId: 'tenant', runId: 'run', token: 'token', slot: hourUtc(new Date()), deadline: Date.now() + 300000 };
  const warehouse = { operations: false, claim: jest.fn(), heartbeat: jest.fn(), snapshot: jest.fn(), extracted: jest.fn(), publish: jest.fn(), status: jest.fn(), fail: jest.fn() };
  const source = { extract: jest.fn(), commercialEligibility:jest.fn() };
  const service = new EtlService(source as any, warehouse as any);
  beforeEach(() => {
    jest.resetAllMocks(); source.commercialEligibility.mockResolvedValue({bi:true,statistics:true}); warehouse.operations = false; warehouse.claim.mockResolvedValue(lease); warehouse.status.mockResolvedValue('running');
    source.extract.mockImplementation(async (_tenant, consumer) => {
      await consumer.snapshot({ tenantId: 'tenant', name: 'Synthetic', isActive: true, at: new Date() });
      return { categories: 0n, testimonials: 0n, events: 0n };
    });
  });
  it('does not claim or extract a tenant without commercial BI eligibility',async()=>{
    source.commercialEligibility.mockResolvedValue({bi:false,statistics:false});
    expect(await service.runTenant('tenant')).toMatchObject({status:'skipped',code:'BI_BILLING_SUSPENDED'});expect(warehouse.claim).not.toHaveBeenCalled();expect(source.extract).not.toHaveBeenCalled();
  });
  it('publishes BI base including taxonomy while optional statistical jobs are disallowed',async()=>{
    source.commercialEligibility.mockResolvedValue({bi:true,statistics:false});
    expect(await service.runTenant('tenant')).toMatchObject({status:'succeeded'});
    expect(warehouse.publish).toHaveBeenCalledWith(lease,expect.objectContaining({tenantId:'tenant',at:expect.any(Date)}),{categories:0n,testimonials:0n,events:0n});
  });
  it('does not re-extract or publish after commercial permission is withdrawn before publication',async()=>{
    source.commercialEligibility.mockResolvedValueOnce({bi:true,statistics:true}).mockResolvedValue({bi:false,statistics:false});
    expect(await service.runTenant('tenant')).toMatchObject({status:'failed',code:'BI_BILLING_SUSPENDED'});expect(warehouse.publish).not.toHaveBeenCalled();expect(source.extract).toHaveBeenCalledTimes(1);
  });
  it('resolves an ambiguous response after a committed publication without retrying', async () => {
    warehouse.publish.mockRejectedValueOnce(new Error('connection closed after commit'));
    warehouse.status.mockResolvedValue('succeeded');
    expect(await service.runTenant('tenant')).toMatchObject({ status: 'succeeded', runId: 'run' });
    expect(warehouse.claim).toHaveBeenCalledTimes(1);
    expect(warehouse.fail).not.toHaveBeenCalled();
  });
  it('caps retries and preserves technical error codes without logging payloads', async () => {
    source.extract.mockRejectedValue(new EtlError('BI_SOURCE_INCONSISTENT'));
    expect(await service.runTenant('tenant')).toMatchObject({ status: 'failed', code: 'BI_SOURCE_INCONSISTENT' });
    expect(warehouse.claim).toHaveBeenCalledTimes(3);
    expect(warehouse.publish).not.toHaveBeenCalled();
  });
  it('abandons a slot when the source hour advances and publishes only the actual observed cut', async () => {
    const nextSlot = new Date(lease.slot.getTime() + 3600000);
    warehouse.claim.mockResolvedValueOnce(lease).mockResolvedValueOnce({ ...lease, runId: 'next-run', slot: nextSlot });
    source.extract.mockImplementation(async (_tenant, consumer) => {
      await consumer.snapshot({ tenantId: 'tenant', name: 'Synthetic', isActive: true, at: new Date(nextSlot.getTime() + 1) });
      return { categories: 0n, testimonials: 0n, events: 0n };
    });
    expect(await service.runTenant('tenant')).toMatchObject({ status: 'succeeded', runId: 'next-run' });
    expect(warehouse.fail).toHaveBeenCalledWith(lease, 'BI_SLOT_CHANGED');
    expect(warehouse.claim).toHaveBeenNthCalledWith(2, 'tenant', nextSlot);
    expect(warehouse.snapshot).toHaveBeenCalledTimes(1);
    expect(warehouse.publish).toHaveBeenCalledTimes(1);
    expect(warehouse.publish.mock.calls[0]?.[0].slot).toEqual(nextSlot);
  });
  it('stops before extraction when shutdown is requested', async () => {
    const controller = new AbortController(); controller.abort();
    expect(await service.runTenant('tenant', controller.signal)).toMatchObject({ status: 'skipped' });
    expect(source.extract).not.toHaveBeenCalled();
  });
  it('does not move a managed request into another observed hour', async () => {
    warehouse.operations = true;
    source.extract.mockImplementation(async (_tenant, consumer) => {
      await consumer.snapshot({ tenantId: 'tenant', name: 'Synthetic', isActive: true, at: new Date(lease.slot.getTime() + 3600001) });
      return { categories: 0n, testimonials: 0n, events: 0n };
    });
    expect(await service.runTenant('tenant', undefined, 'cli')).toMatchObject({ status: 'failed', code: 'BI_SLOT_CHANGED' });
    expect(warehouse.claim).toHaveBeenCalledTimes(1); expect(warehouse.publish).not.toHaveBeenCalled();
  });
  it('drains an active managed load after a shutdown signal instead of interrupting publication', async () => {
    warehouse.operations = true; const controller = new AbortController();
    source.extract.mockImplementation(async (_tenant, consumer) => {
      await consumer.snapshot({ tenantId: 'tenant', name: 'Synthetic', isActive: true, at: new Date() });
      controller.abort(); return { categories: 0n, testimonials: 0n, events: 0n };
    });
    expect(await service.runTenant('tenant', controller.signal)).toMatchObject({ status: 'succeeded' });
    expect(warehouse.publish).toHaveBeenCalledTimes(1);
  });
  it('defers managed automatic retries to later polling rather than burning three attempts in one tick', async () => {
    warehouse.operations = true; source.extract.mockRejectedValue(new EtlError('BI_SOURCE_INCONSISTENT'));
    expect(await service.runTenant('tenant')).toMatchObject({ status: 'failed' });
    expect(warehouse.claim).toHaveBeenCalledTimes(1);
    expect(warehouse.claim).toHaveBeenCalledWith('tenant', expect.any(Date), 'scheduled');
  });
});

describe('tenant-scoped scoring orchestration', () => {
  it('passes each company through reads and updates while preserving the formula', async () => {
    const now = new Date();
    const repo = { findScoringTenantIds: jest.fn().mockResolvedValue(['a', 'b']),
      findPublishedForScoring: jest.fn().mockImplementation(async (tenant: string) => [{ id: `${tenant}-testimonial`, rating: 5, publishedAt: now }]),
      updateScores: jest.fn().mockResolvedValue(1) };
    const analytics = { getEngagementCounts: jest.fn().mockResolvedValue(new Map([['a-testimonial', { views: 10, clicks: 2 }]])) };
    await new ScoringService(repo as any, analytics as any).processScores();
    expect(analytics.getEngagementCounts).toHaveBeenNthCalledWith(1, 'a', ['a-testimonial']);
    expect(analytics.getEngagementCounts).toHaveBeenNthCalledWith(2, 'b', ['b-testimonial']);
    expect(repo.updateScores).toHaveBeenNthCalledWith(1, 'a', [{ id: 'a-testimonial', score: 52 }]);
    expect(repo.updateScores).toHaveBeenNthCalledWith(2, 'b', [{ id: 'b-testimonial', score: 50 }]);
  });
});
