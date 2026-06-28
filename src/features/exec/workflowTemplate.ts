import { stringify as stringifyYaml } from 'yaml';
import type { ProviderType } from '../../infra/providers/index.js';
import {
  assertExecProviderEffort,
  assertResolvedExecConfig,
  CLAUDE_TOOL_PROVIDERS,
  providerAllowsOmittedExecModel,
} from './configValidation.js';
import type { ExecConfig, ExecEffort, ResolvedExecActorConfig, ResolvedExecConfig } from './types.js';

interface BuildExecWorkflowOptions {
  workflowName: string;
  taskDescription: string;
}

type ProviderOptions = {
  claude?: {
    effort?: ExecEffort;
    allowed_tools?: string[];
  };
  codex?: {
    reasoning_effort?: ExecEffort;
  };
  copilot?: {
    effort?: ExecEffort;
  };
};

const WORKER_CLAUDE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'];
const JUDGE_CLAUDE_TOOLS = ['Read', 'Glob', 'Grep'];

function buildModelEntry(provider: ProviderType, model: string | undefined): { model?: string | null } {
  if (model !== undefined) {
    return { model };
  }
  if (providerAllowsOmittedExecModel(provider)) {
    return { model: null };
  }
  return {};
}

function buildProviderOptions(
  provider: ProviderType,
  model: string | undefined,
  effort: ExecEffort | undefined,
  claudeAllowedTools: string[],
): ProviderOptions | undefined {
  assertExecProviderEffort(provider, model, effort, 'exec provider_options.effort');
  if (CLAUDE_TOOL_PROVIDERS.has(provider)) {
    return {
      claude: {
        ...(effort !== undefined ? { effort } : {}),
        allowed_tools: claudeAllowedTools,
      },
    };
  }
  if (provider === 'codex' && effort !== undefined) {
    return { codex: { reasoning_effort: effort } };
  }
  if (provider === 'copilot' && effort !== undefined) {
    return { copilot: { effort } };
  }
  return undefined;
}

function buildSessionJudgeProviderFields(config: ResolvedExecConfig): Record<string, unknown> {
  const providerOptions = buildProviderOptions(
    config.session.provider,
    config.session.model,
    config.session.effort,
    JUDGE_CLAUDE_TOOLS,
  );
  return {
    provider: config.session.provider,
    ...buildModelEntry(config.session.provider, config.session.model),
    ...(providerOptions !== undefined ? { provider_options: providerOptions } : {}),
  };
}

export function buildJudgeReportName(actorName: string): string {
  return `${actorName}-judge-result.md`;
}

function buildActorStep(actor: ResolvedExecActorConfig, edit: boolean, claudeAllowedTools: string[]): Record<string, unknown> {
  const providerOptions = buildProviderOptions(actor.provider, actor.model, actor.effort, claudeAllowedTools);
  return {
    name: actor.name,
    session_key: actor.name,
    tags: edit ? ['coding'] : ['review'],
    edit,
    persona: edit ? 'exec-worker' : 'exec-assistant',
    instruction: actor.instruction,
    ...(actor.knowledge.length > 0 ? { knowledge: actor.knowledge } : {}),
    ...(actor.policy.length > 0 ? { policy: actor.policy } : {}),
    provider: actor.provider,
    ...buildModelEntry(actor.provider, actor.model),
    ...(providerOptions !== undefined ? { provider_options: providerOptions } : {}),
    ...(edit ? { required_permission_mode: 'edit' } : {}),
    ...(!edit ? {
      pass_previous_response: false,
      output_contracts: {
        report: [
          {
            name: buildJudgeReportName(actor.name),
            format: 'exec-judge-result',
          },
        ],
      },
    } : {}),
    rules: edit
      ? [{ condition: 'done' }, { condition: 'blocked' }]
      : [{ condition: 'approved' }, { condition: 'needs_fix' }, { condition: 'needs_replan' }],
  };
}

function buildReplanStep(config: ResolvedExecConfig): Record<string, unknown> {
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
    ...buildSessionJudgeProviderFields(config),
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
        cycle: ['execute', 'judge'],
        threshold: config.loop.smallThreshold,
        judge: {
          session_key: 'exec-loop-monitor-small',
          persona: 'exec-assistant',
          instruction: 'exec-loop-monitor',
          ...buildSessionJudgeProviderFields(config),
          rules: [
            { condition: 'Healthy (progress being made)', next: 'execute' },
            { condition: 'Unproductive (same rework repeating)', next: 'replan' },
          ],
        },
      },
      {
        cycle: ['replan', 'execute', 'judge'],
        threshold: config.loop.largeThreshold,
        judge: {
          session_key: 'exec-loop-monitor-large',
          persona: 'exec-assistant',
          instruction: 'exec-loop-monitor',
          ...buildSessionJudgeProviderFields(config),
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
        parallel: config.workers.map((worker) => buildActorStep(worker, true, WORKER_CLAUDE_TOOLS)),
        rules: [
          { condition: 'all("done")', next: 'judge' },
          { condition: 'any("blocked")', next: 'judge' },
        ],
      },
      {
        name: 'judge',
        pass_previous_response: false,
        parallel: config.judges.map((judge) => buildActorStep(judge, false, JUDGE_CLAUDE_TOOLS)),
        rules: [
          { condition: 'all("approved")', next: 'COMPLETE' },
          { condition: 'any("needs_replan")', next: 'replan' },
          { condition: 'any("needs_fix")', next: 'execute' },
        ],
      },
      buildReplanStep(config),
    ],
  };
  return stringifyYaml(workflow, { aliasDuplicateObjects: false });
}
