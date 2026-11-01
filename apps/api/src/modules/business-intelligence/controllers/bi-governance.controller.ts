import {Body,Controller,Get,Headers,HttpCode,Param,ParseUUIDPipe,Patch,Post,Query,UseGuards} from '@nestjs/common';
import {CurrentUser} from '../../../common/decorators/current-user.decorator';
import {Roles} from '../../../common/decorators/roles.decorator';
import {RateLimit} from '../../../common/decorators/rate-limit.decorator';
import {JwtAuthGuard} from '../../../common/guards/jwt-auth.guard';
import {RolesGuard} from '../../../common/guards/roles.guard';
import {RateLimitGuard} from '../../../common/guards/rate-limit.guard';
import type {AuthenticatedUser} from '../../../common/interfaces/auth-context.interface';
import {GovernanceCommandService} from '../services/governance-command.service';
import {GovernanceEvaluationService} from '../services/governance-evaluation.service';
import {EmptyGovernanceQueryDto,GovernanceListDto,GovernancePageDto,CreateKpiDto,CreateObjectiveDto,EditKpiDto,EditObjectiveDto,AddResultDto,EditResultDto,ManualProgressDto,GoalTransitionDto} from '../dtos/governance.dto';
@Controller('bi')
@UseGuards(JwtAuthGuard,RolesGuard,RateLimitGuard)
@Roles('admin','editor')
@RateLimit({limit:120,windowSeconds:60})
export class BiGovernanceController {
  constructor(private readonly commands:GovernanceCommandService,private readonly evaluations:GovernanceEvaluationService) {}
  @Get('kpis') kpis(@CurrentUser() user:AuthenticatedUser,@Query() query:GovernanceListDto){return this.evaluations.read(user,'kpi',query);}
  @Get('objectives') objectives(@CurrentUser() user:AuthenticatedUser,@Query() query:GovernanceListDto){return this.evaluations.read(user,'objective',query);}
  @Get('kpis/:id') kpi(@CurrentUser() user:AuthenticatedUser,@Param('id',new ParseUUIDPipe()) id:string,@Query() _query:EmptyGovernanceQueryDto){return this.evaluations.detail(user,'kpi',id);}
  @Get('objectives/:id') objective(@CurrentUser() user:AuthenticatedUser,@Param('id',new ParseUUIDPipe()) id:string,@Query() _query:EmptyGovernanceQueryDto){return this.evaluations.detail(user,'objective',id);}
  @Post('kpis') @Roles('admin') @RateLimit({limit:20,windowSeconds:60})
  createKpi(@CurrentUser() user:AuthenticatedUser,@Body() body:CreateKpiDto,@Headers('idempotency-key') key:string|undefined,@Query() _query:EmptyGovernanceQueryDto){return this.commands.create(user,'kpi',body,key);}
  @Post('objectives') @Roles('admin') @RateLimit({limit:20,windowSeconds:60})
  createObjective(@CurrentUser() user:AuthenticatedUser,@Body() body:CreateObjectiveDto,@Headers('idempotency-key') key:string|undefined,@Query() _query:EmptyGovernanceQueryDto){return this.commands.create(user,'objective',body,key);}
  @Patch('kpis/:id') @Roles('admin') @RateLimit({limit:20,windowSeconds:60})
  editKpi(@CurrentUser() user:AuthenticatedUser,@Param('id',new ParseUUIDPipe()) id:string,@Body() body:EditKpiDto,@Query() _query:EmptyGovernanceQueryDto){return this.commands.edit(user,'kpi',id,body);}
  @Patch('objectives/:id') @Roles('admin') @RateLimit({limit:20,windowSeconds:60})
  editObjective(@CurrentUser() user:AuthenticatedUser,@Param('id',new ParseUUIDPipe()) id:string,@Body() body:EditObjectiveDto,@Query() _query:EmptyGovernanceQueryDto){return this.commands.edit(user,'objective',id,body);}
  @Post('kpis/:id/transitions') @HttpCode(200) @Roles('admin') @RateLimit({limit:20,windowSeconds:60})
  transitionKpi(@CurrentUser() user:AuthenticatedUser,@Param('id',new ParseUUIDPipe()) id:string,@Body() body:GoalTransitionDto,@Headers('idempotency-key') key:string|undefined,@Query() _query:EmptyGovernanceQueryDto){return this.commands.transition(user,'kpi',id,body,key);}
  @Post('objectives/:id/transitions') @HttpCode(200) @Roles('admin') @RateLimit({limit:20,windowSeconds:60})
  transitionObjective(@CurrentUser() user:AuthenticatedUser,@Param('id',new ParseUUIDPipe()) id:string,@Body() body:GoalTransitionDto,@Headers('idempotency-key') key:string|undefined,@Query() _query:EmptyGovernanceQueryDto){return this.commands.transition(user,'objective',id,body,key);}
  @Post('objectives/:id/key-results') @Roles('admin') @RateLimit({limit:20,windowSeconds:60})
  addResult(@CurrentUser() user:AuthenticatedUser,@Param('id',new ParseUUIDPipe()) id:string,@Body() body:AddResultDto,@Headers('idempotency-key') key:string|undefined,@Query() _query:EmptyGovernanceQueryDto){return this.commands.addResult(user,id,body,key);}
  @Patch('objectives/:id/key-results/:resultId') @Roles('admin') @RateLimit({limit:20,windowSeconds:60})
  editResult(@CurrentUser() user:AuthenticatedUser,@Param('id',new ParseUUIDPipe()) id:string,@Param('resultId',new ParseUUIDPipe()) resultId:string,@Body() body:EditResultDto,@Query() _query:EmptyGovernanceQueryDto){return this.commands.editResult(user,id,resultId,body);}
  @Get('objectives/:id/key-results/:resultId/progress')
  history(@CurrentUser() user:AuthenticatedUser,@Param('id',new ParseUUIDPipe()) id:string,@Param('resultId',new ParseUUIDPipe()) resultId:string,@Query() query:GovernancePageDto){return this.evaluations.history(user,id,resultId,query);}
  @Post('objectives/:id/key-results/:resultId/progress') @RateLimit({limit:20,windowSeconds:60})
  progress(@CurrentUser() user:AuthenticatedUser,@Param('id',new ParseUUIDPipe()) id:string,@Param('resultId',new ParseUUIDPipe()) resultId:string,@Body() body:ManualProgressDto,@Headers('idempotency-key') key:string|undefined,@Query() _query:EmptyGovernanceQueryDto){return this.commands.recordProgress(user,id,resultId,body,key);}
}
