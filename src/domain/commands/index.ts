import type { CommandDef } from '../engine';
import { campaignCommands } from './campaigns';
import { demoCommands } from './demo';
import { orchestratorCommands } from './orchestrator';
import { rewardCommands } from './rewards';
import { seedCommand } from './seed';

export const ALL_COMMANDS: CommandDef[] = [...campaignCommands, ...orchestratorCommands, ...rewardCommands, ...demoCommands, seedCommand];

export { SEED_ACTOR, SEED_REQUEST } from './seed';
