import {createZodDto} from 'nestjs-zod';
import {z} from 'zod';
import {governanceListSchema,governancePageSchema,kpiDefinitionSchema,objectiveDefinitionSchema,keyResultDefinitionSchema,manualProgressSchema,transitionSchema} from '../contracts/unified-bi.contract';
const version=z.number().int().min(0).max(2147483646);
export class EmptyGovernanceQueryDto extends createZodDto(z.object({}).strict()) {}
export class GovernanceListDto extends createZodDto(governanceListSchema) {}
export class GovernancePageDto extends createZodDto(governancePageSchema) {}
export class CreateKpiDto extends createZodDto(kpiDefinitionSchema) {}
export class CreateObjectiveDto extends createZodDto(objectiveDefinitionSchema) {}
export class EditKpiDto extends createZodDto(z.object({expectedVersion:version,definition:kpiDefinitionSchema}).strict()) {}
export class EditObjectiveDto extends createZodDto(z.object({expectedVersion:version,definition:objectiveDefinitionSchema}).strict()) {}
export class AddResultDto extends createZodDto(z.object({expectedVersion:version,definition:keyResultDefinitionSchema}).strict()) {}
export class EditResultDto extends createZodDto(z.object({expectedVersion:version,expectedObjectiveVersion:version,definition:keyResultDefinitionSchema}).strict()) {}
export class ManualProgressDto extends createZodDto(manualProgressSchema) {}
export class GoalTransitionDto extends createZodDto(transitionSchema) {}
