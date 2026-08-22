import { stringify as stringifyYaml } from 'yaml';
import { assertResolvedExecConfig } from './configValidation.js';
import type {
  ExecCodexSkillInheritance,
  ExecConfig,
  ResolvedExecActorConfig,
  ResolvedExecConfig,
} from './types.js';

interface BuildExecWorkflowOptions {
  workflowName: string;
  taskDescription: string;
  codexSkillInheritance: ExecCodexSkillInheritance;
}

function buildCapabilities(edit: boolean, inheritance: ExecCodexSkillInheritance): string | string[] {
  const base = edit ? 'edit' : 'readonly';
  return inheritance.repo || inheritance.user ? [base, 'enable-skills'] : base;
}

export function buildReviewReportName(actorName: string): string {
  return `${actorName}-review-result.md`;
}

function buildActorStep(
  actor: ResolvedExecActorConfig,
  edit: boolean,
  codexSkillInheritance: ExecCodexSkillInheritance,
): Record<string, unknown> {
  return {
    name: actor.name,
    session_key: actor.name,
    tags: edit ? ['coding'] : ['review'],
    edit,
    persona: edit ? 'exec-worker' : 'exec-assistant',
    instruction: actor.instruction,
    ...(actor.knowledge.length > 0 ? { knowledge: actor.knowledge } : {}),
    ...(actor.policy.length > 0 ? { policy: actor.policy } : {}),
    capabilities: buildCapabilities(edit, codexSkillInheritance),
    ...(edit ? { required_permission_mode: 'edit' } : {}),
    ...(!edit ? {
      pass_previous_response: false,
      output_contracts: {
        report: [
          {
            name: buildReviewReportName(actor.name),
            format: 'exec-review-result',
          },
        ],
      },
    } : {}),
    rules: edit
      ? [{ condition: 'done' }, { condition: 'blocked' }]
      : [{ condition: 'approved' }, { condition: 'needs_fix' }, { condition: 'needs_replan' }],
  };
}

function buildReplanStep(
  config: ResolvedExecConfig,
  codexSkillInheritance: ExecCodexSkillInheritance,
): Record<string, unknown> {
  return {
    name: 'replan',
    session_key: 'exec-replan',
    tags: ['plan'],
    edit: false,
    requires_user_input: true,
    persona: 'exec-assistant',
    instruction: config.replan.instruction,
    ...(config.replan.knowledge.length > 0 ? { knowledge: config.replan.knowledge } : {}),
    ...(config.replan.policy.length > 0 ? { policy: config.replan.policy } : {}),
    capabilities: buildCapabilities(false, codexSkillInheritance),
    rules: [
      {
        condition: 'User input needed for clarification',
        next: 'replan',
        requires_user_input: true,
        interactive_only: true,
      },
      { condition: 'New plan ready', next: 'execute' },
      { condition: 'Cannot proceed', next: 'ABORT' },
    ],
  };
}

export function buildExecWorkflowYaml(config: ExecConfig, options: BuildExecWorkflowOptions): string {
  assertResolvedExecConfig(config);
  const workflow = {
    name: options.workflowName,
    description: options.taskDescription,
    max_steps: config.loop.maxSteps,
    initial_step: 'execute',
    loop_monitors: [
      {
        cycle: ['execute', 'review'],
        threshold: config.loop.smallThreshold,
        judge: {
          persona: 'exec-assistant',
          instruction: 'exec-loop-monitor',
          rules: [
            { condition: 'Healthy (progress being made)', next: 'execute' },
            { condition: 'Unproductive (same rework repeating)', next: 'replan' },
          ],
        },
      },
      {
        cycle: ['replan', 'execute', 'review'],
        threshold: config.loop.largeThreshold,
        judge: {
          persona: 'exec-assistant',
          instruction: 'exec-loop-monitor',
          rules: [
            { condition: 'Healthy (progress being made)', next: 'replan' },
            { condition: 'Unproductive (no convergence)', next: 'COMPLETE' },
          ],
        },
      },
    ],
    steps: [
      {
        name: 'execute',
        parallel: config.workers.map((worker) => buildActorStep(worker, true, options.codexSkillInheritance)),
        rules: [
          { condition: 'all("done")', next: 'review' },
          { condition: 'any("blocked")', next: 'review' },
        ],
      },
      {
        name: 'review',
        pass_previous_response: false,
        parallel: config.reviews.map((review) => buildActorStep(review, false, options.codexSkillInheritance)),
        rules: [
          { condition: 'all("approved")', next: 'COMPLETE' },
          { condition: 'any("needs_replan")', next: 'replan' },
          { condition: 'any("needs_fix")', next: 'execute' },
        ],
      },
      buildReplanStep(config, options.codexSkillInheritance),
    ],
  };
  return stringifyYaml(workflow, { aliasDuplicateObjects: false });
}
