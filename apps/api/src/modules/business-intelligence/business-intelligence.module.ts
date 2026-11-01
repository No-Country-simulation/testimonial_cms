import { BiAnalyticalController } from './controllers/bi-analytical.controller';
import { ActivityRepository } from './repositories/activity.repository';
import { ExplorationRepository } from './repositories/exploration.repository';
import { AnalyticalReadService } from './services/analytical-read.service';
import { BiGovernanceController } from './controllers/bi-governance.controller';
import { GovernanceRepository } from './repositories/governance.repository';
import { PeriodMeasurementsRepository } from './repositories/period-measurements.repository';
import { GovernanceEvaluationService } from './services/governance-evaluation.service';
import { GovernanceCommandService } from './services/governance-command.service';
import { BiStatisticsController, BiStatisticsGuard } from './controllers/bi-statistics.controller';
import { StatisticsReadRepository } from './repositories/statistics-read.repository';
import { StatisticsReadService } from './services/statistics-read.service';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { BiController } from './controllers/bi.controller';
import { BiConnection } from './repositories/bi-connection';
import { DashboardRepository } from './repositories/dashboard.repository';
import { DashboardService } from './services/dashboard.service';
import { BiMetricsService } from './services/bi-metrics.service';
import { BiMetricsController } from './controllers/bi-metrics.controller';

import { BiOperationsController, BiIdempotencyKeyPipe } from './controllers/bi-operations.controller';
import { BiPrivateMiddleware } from './guards/bi-private.middleware';
import { BiOperationsGuard } from './guards/bi-operations.guard';
import { BiControlConnection } from './repositories/bi-control-connection';
import { OperationsReadRepository } from './repositories/operations-read.repository';
import { OperationsControlRepository } from './repositories/operations-control.repository';
import { OperationsService } from './services/operations.service';

@Module({ controllers: [BiAnalyticalController,BiGovernanceController,BiController, BiMetricsController, BiOperationsController, BiStatisticsController], providers: [
  GovernanceRepository,GovernanceEvaluationService,GovernanceCommandService,ActivityRepository,AnalyticalReadService,
  {provide:ExplorationRepository,inject:[BiConnection],useFactory:(connection:BiConnection)=>new ExplorationRepository(connection)},
  {provide:PeriodMeasurementsRepository,inject:[BiConnection],useFactory:(connection:BiConnection)=>new PeriodMeasurementsRepository(connection)},
  BiConnection, BiControlConnection, DashboardRepository, DashboardService, BiMetricsService, BiStatisticsGuard, StatisticsReadService,
  { provide: StatisticsReadRepository, inject: [BiConnection], useFactory: (connection: BiConnection) => new StatisticsReadRepository(connection) },
  BiOperationsGuard, BiIdempotencyKeyPipe, OperationsService,
  { provide: OperationsReadRepository, inject: [BiConnection], useFactory: (connection: BiConnection) => new OperationsReadRepository(connection) },
  { provide: OperationsControlRepository, inject: [BiControlConnection], useFactory: (connection: BiControlConnection) => new OperationsControlRepository(connection) },
] })
export class BusinessIntelligenceModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(BiPrivateMiddleware).forRoutes(BiAnalyticalController,BiGovernanceController,BiController, BiOperationsController, BiStatisticsController);
  }
}
