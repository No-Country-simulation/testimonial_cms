import {Controller,Get,Query,UseGuards} from '@nestjs/common';
import {createZodDto} from 'nestjs-zod';
import {CurrentTenantId} from '../../../common/decorators/current-tenant.decorator';
import {Roles} from '../../../common/decorators/roles.decorator';
import {RateLimit} from '../../../common/decorators/rate-limit.decorator';
import {JwtAuthGuard} from '../../../common/guards/jwt-auth.guard';
import {RolesGuard} from '../../../common/guards/roles.guard';
import {RateLimitGuard} from '../../../common/guards/rate-limit.guard';
import {analyticsQuerySchema,activityQuerySchema} from '../contracts/unified-bi.contract';
import {METRIC_CATALOG,METRIC_CATALOG_VERSION} from '../contracts/metric-catalog';
import {filterOptionsQuerySchema} from '../repositories/exploration.repository';
import {ActivityRepository} from '../repositories/activity.repository';
import {AnalyticalReadService} from '../services/analytical-read.service';
import {EmptyGovernanceQueryDto} from '../dtos/governance.dto';
export class AnalyticalQueryDto extends createZodDto(analyticsQuerySchema) {}
export class ActivityQueryDto extends createZodDto(activityQuerySchema) {}
export class FilterOptionsDto extends createZodDto(filterOptionsQuerySchema) {}
@Controller('bi')
@UseGuards(JwtAuthGuard,RolesGuard,RateLimitGuard)
@Roles('admin','editor')
@RateLimit({limit:120,windowSeconds:60})
export class BiAnalyticalController {
  constructor(private readonly reads:AnalyticalReadService,private readonly activity:ActivityRepository) {}
  @Get('metric-catalog') catalog(@Query() _query:EmptyGovernanceQueryDto){return {version:METRIC_CATALOG_VERSION,metrics:METRIC_CATALOG};}
  @Get('overview') overview(@CurrentTenantId() tenantId:string,@Query() query:AnalyticalQueryDto){return this.reads.overview(tenantId,query);}
  @Get('breakdowns') breakdowns(@CurrentTenantId() tenantId:string,@Query() query:AnalyticalQueryDto){return this.reads.breakdowns(tenantId,query);}
  @Get('filter-options') filters(@CurrentTenantId() tenantId:string,@Query() query:FilterOptionsDto){return this.reads.filterOptions(tenantId,query);}
  @Get('activity') events(@CurrentTenantId() tenantId:string,@Query() query:ActivityQueryDto){return this.activity.read(tenantId,query);}
}
