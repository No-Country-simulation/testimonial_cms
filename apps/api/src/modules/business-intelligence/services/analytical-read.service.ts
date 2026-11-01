import {Injectable} from '@nestjs/common';
import {ExplorationRepository} from '../repositories/exploration.repository';
import {OperationsReadRepository} from '../repositories/operations-read.repository';
import {METRIC_CATALOG_VERSION} from '../contracts/metric-catalog';
import type {BiProvenance} from '../contracts/unified-bi.types';
import type {BiSettings} from '../operations.types';
import type {PeriodMeasurementsRepository} from '../repositories/period-measurements.repository';
import type {DateRange} from '../dtos/dashboard-query.dto';
import {METRIC_IDS} from '../contracts/metric-catalog';
import {missing} from '../utils/measurement-engine';
type Period=Awaited<ReturnType<PeriodMeasurementsRepository['period']>>;
@Injectable()
export class AnalyticalReadService {
  constructor(private readonly explore:ExplorationRepository,private readonly operations:OperationsReadRepository) {}
  private provenance(period:Period,range:DateRange,settings:BiSettings,now:Date):BiProvenance{
    const threshold=settings.frequencyHours*3600+settings.delayToleranceMinutes*60;
    const end=range.to===now.toISOString().slice(0,10)?now.getTime():Date.parse(`${range.to}T23:59:59.999Z`);
    const source=period.closingCut;const latest=period.reconciliation;
    return {observedAt:period.observedAt?.toISOString()??now.toISOString(),closingCut:source?{runId:source.id,snapshotAt:source.at.toISOString(),publishedAt:source.published.toISOString()}:null,
      engagementReconciliation:latest?{runId:latest.id,snapshotAt:new Date(latest.at).toISOString(),publishedAt:new Date(latest.published).toISOString()}:null,
      tagsAtClosingCut:period.tagsObserved?'observed':'not_observed',creationHistoryStartedAt:period.creationHistoryStartedAt?.toISOString()??null,
      staleAfterSeconds:threshold,frequencyHours:settings.frequencyHours,delayToleranceMinutes:settings.delayToleranceMinutes,
      closingCutStale:source?Math.max(0,end-source.at.getTime())>threshold*1000:null};
  }
  async overview(tenantId:string,input:unknown,now=new Date()){
    const [result,settings]=await Promise.all([this.explore.overview(tenantId,input,now),this.operations.settings(tenantId)]);
    return {contractVersion:'bi_overview_v1',catalogVersion:METRIC_CATALOG_VERSION,range:result.range,filters:result.filters,
      provenance:this.provenance(result.period,result.range,settings,now),metrics:result.period.metrics,
      previous:{range:result.previousRange,provenance:result.previous&&result.previousRange?this.provenance(result.previous,result.previousRange,settings,now):null,
        metrics:result.previous?.metrics??Object.fromEntries(METRIC_IDS.map(id=>[id,missing('OUTSIDE_COVERAGE')]))},
      comparisons:result.comparisons,daily:result.items};
  }
  async breakdowns(tenantId:string,input:unknown,now=new Date()){
    const [result,settings]=await Promise.all([this.explore.breakdowns(tenantId,input,now),this.operations.settings(tenantId)]);
    const {period,...visible}=result;
    return {...visible,contractVersion:'bi_breakdowns_v1',catalogVersion:METRIC_CATALOG_VERSION,metrics:period.metrics,
      provenance:this.provenance(period,result.range,settings,now)};
  }
  filterOptions(tenantId:string,input:unknown){return this.explore.filterOptions(tenantId,input);}
}
