import type { ProviderType } from '../../infra/providers/index.js';
import { selectOption } from '../../shared/prompt/index.js';
import { resolveTtyPolicy } from '../../shared/prompt/tty.js';
import { info } from '../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../shared/utils/index.js';
import {
  assertExecActorName,
  assertExecConfig,
  assertExecProviderEffort,
  EXEC_PROVIDERS,
  getExecModelCandidates,
  getSupportedExecEfforts,
} from './configValidation.js';
import {
  formatProviderModel,
  formatActorDetails,
  resolveEffortAfterProviderOverride,
  resolveModelAfterProviderOverride,
} from './configOps.js';
import { DEFAULT_EXEC_CONFIG } from './defaults.js';
import { editFacetRefList, editInstructionFacetRef } from './facetEditor.js';
import { editPresetSetup } from './presetSetup.js';
import { promptInteger, promptText } from './promptUtils.js';
import { ProjectBoundaryError } from './projectLocalFiles.js';
import {
  createExecSessionContext,
  shouldKeepExecSession,
  type ExecSessionContext,
} from './assistantSession.js';
import type { ExecActorConfig, ExecConfig, ExecEffort, ExecSessionConfig } from './types.js';

type SetupSection = 'assistant' | 'workers' | 'judges' | 'replan' | 'loop' | 'preset' | 'back';
type SetupSectionOption = { label: string; value: SetupSection };
const CUSTOM_MODEL_VALUE = '__custom_model__';

function supportsAnyExecEffort(provider: ProviderType): boolean {
  return getSupportedExecEfforts(provider).length > 0;
}

function shouldKeepSetupMenuOpen(): boolean {
  return resolveTtyPolicy().useTty && !process.stdin.readableEnded;
}

function buildSetupSectionOptions(current: ExecConfig): SetupSectionOption[] {
  return [
    {
      label: [
        'Assistant: ',
        formatProviderModel(current.session.provider, current.session.model),
        `/${sanitizeTerminalText(current.session.effort ?? 'none')}`,
      ].join(''),
      value: 'assistant',
    },
    { label: `Workers: ${current.workers.length}`, value: 'workers' },
    { label: `Judges: ${current.judges.length}`, value: 'judges' },
    { label: `Replan: ${sanitizeTerminalText(current.replan.instruction)}`, value: 'replan' },
    { label: `Loop: ${current.loop.smallThreshold}/${current.loop.largeThreshold}/${current.loop.maxSteps}`, value: 'loop' },
    { label: 'Preset', value: 'preset' },
    { label: 'Back', value: 'back' },
  ];
}

function formatFacetListForTerminal(values: string[]): string {
  return values.length > 0 ? values.map((value) => sanitizeTerminalText(value)).join(', ') : 'none';
}

function buildNextActorName(label: string, actors: ExecActorConfig[]): string {
  const prefix = label.toLowerCase().slice(0, -1);
  const existingNames = new Set(actors.map((actor) => actor.name));
  for (let index = 1; index <= actors.length + 1; index += 1) {
    const candidate = `${prefix}-${index}`;
    if (!existingNames.has(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Unable to allocate ${label} actor name.`);
}

async function selectProvider(current: ProviderType): Promise<ProviderType> {
  const selected = await selectOption<ProviderType>('Provider', EXEC_PROVIDERS.map((provider) => ({
    label: provider === current ? `${provider} (current)` : provider,
    value: provider,
  })));
  return selected ?? current;
}

async function selectEffort(provider: ProviderType, current: ExecEffort | undefined): Promise<ExecEffort | undefined> {
  const efforts = getSupportedExecEfforts(provider);
  if (efforts.length === 0) {
    throw new Error(`Provider "${provider}" does not support exec effort selection.`);
  }
  const selected = await selectOption<ExecEffort>('Effort', efforts.map((effort) => ({
    label: effort === current ? `${effort} (current)` : effort,
    value: effort,
  })));
  if (selected === null) {
    return current;
  }
  return selected;
}

function formatModelValue(model: string | undefined): string {
  return model === undefined ? 'provider default' : sanitizeTerminalText(model);
}

function requireCustomModelInput(model: string): string {
  if (model.trim().length === 0) {
    throw new Error('Custom model must be a non-empty string.');
  }
  return model;
}

async function selectModel(provider: ProviderType, current: string | undefined, lang: ExecSessionContext['lang']): Promise<string | undefined> {
  const candidates = [...new Set([
    ...getExecModelCandidates(provider),
    ...(current !== undefined ? [current] : []),
  ])];
  const selected = await selectOption<string>('Model', [
    ...candidates.map((model) => ({
      label: model === current ? `${sanitizeTerminalText(model)} (current)` : sanitizeTerminalText(model),
      value: model,
    })),
    { label: 'Custom input...', value: CUSTOM_MODEL_VALUE },
  ]);
  if (selected === null) {
    return current;
  }
  if (selected === CUSTOM_MODEL_VALUE) {
    const model = await promptText('Custom model', current ?? '', lang);
    return requireCustomModelInput(model);
  }
  return selected;
}

async function editSessionConfig(session: ExecSessionConfig, lang: ExecSessionContext['lang']): Promise<ExecSessionConfig> {
  let current = session;
  while (true) {
    const options: Array<{ label: string; value: 'provider' | 'model' | 'effort' | 'back' }> = [
      { label: `Provider: ${sanitizeTerminalText(current.provider)}`, value: 'provider' },
      { label: `Model: ${formatModelValue(current.model)}`, value: 'model' },
    ];
    if (supportsAnyExecEffort(current.provider)) {
      options.push({ label: `Effort: ${sanitizeTerminalText(current.effort ?? 'none')}`, value: 'effort' });
    }
    options.push({ label: 'Back', value: 'back' });
    const field = await selectOption<'provider' | 'model' | 'effort' | 'back'>('Assistant settings', options);
    if (field === null || field === 'back') {
      return current;
    }
    if (field === 'provider') {
      const provider = await selectProvider(current.provider);
      current = {
        ...current,
        provider,
        model: resolveModelAfterProviderOverride(current.provider, provider, current.model, undefined),
        effort: resolveEffortAfterProviderOverride(current.provider, provider, current.effort),
      };
    }
    if (field === 'model') {
      current = { ...current, model: await selectModel(current.provider, current.model, lang) };
    }
    if (field === 'effort') {
      current = { ...current, effort: await selectEffort(current.provider, current.effort) };
    }
    assertExecProviderEffort(current.provider, current.model, current.effort, 'exec.session.effort');
    if (!shouldKeepSetupMenuOpen()) {
      return current;
    }
  }
}

async function editActor(
  cwd: string,
  actor: ExecActorConfig,
  defaultActor: ExecActorConfig,
  ctx: ExecSessionContext,
): Promise<ExecActorConfig> {
  let current = actor;
  while (true) {
    const options: Array<{
      label: string;
      value: 'name' | 'provider' | 'model' | 'effort' | 'instruction' | 'knowledge' | 'policy' | 'back';
    }> = [
      { label: `Name: ${sanitizeTerminalText(current.name)}`, value: 'name' },
      { label: `Provider: ${sanitizeTerminalText(current.provider)}`, value: 'provider' },
      { label: `Model: ${formatModelValue(current.model)}`, value: 'model' },
    ];
    if (supportsAnyExecEffort(current.provider)) {
      options.push({ label: `Effort: ${sanitizeTerminalText(current.effort ?? 'none')}`, value: 'effort' });
    }
    options.push(
      { label: `Instruction: ${sanitizeTerminalText(current.instruction)}`, value: 'instruction' },
      { label: `Knowledge: ${formatFacetListForTerminal(current.knowledge)}`, value: 'knowledge' },
      { label: `Policy: ${formatFacetListForTerminal(current.policy)}`, value: 'policy' },
      { label: 'Back', value: 'back' },
    );
    const field = await selectOption<'name' | 'provider' | 'model' | 'effort' | 'instruction' | 'knowledge' | 'policy' | 'back'>(
      `${current.name} settings`,
      options,
    );
    if (field === null || field === 'back') {
      return current;
    }
    if (field === 'name') {
      const name = await promptText('Name', current.name, ctx.lang);
      assertExecActorName(name, `exec.${current.name}.name`);
      current = { ...current, name };
    }
    if (field === 'provider') {
      const provider = await selectProvider(current.provider);
      current = {
        ...current,
        provider,
        model: resolveModelAfterProviderOverride(current.provider, provider, current.model, undefined),
        effort: resolveEffortAfterProviderOverride(current.provider, provider, current.effort),
      };
    }
    if (field === 'model') {
      current = { ...current, model: await selectModel(current.provider, current.model, ctx.lang) };
    }
    if (field === 'effort') {
      current = { ...current, effort: await selectEffort(current.provider, current.effort) };
    }
    if (field === 'instruction') {
      current = {
        ...current,
        instruction: await editInstructionFacetRef(cwd, current.instruction, defaultActor.instruction, ctx),
      };
    }
    if (field === 'knowledge') {
      current = { ...current, knowledge: await editFacetRefList(cwd, 'knowledge', current.knowledge, ctx) };
    }
    if (field === 'policy') {
      current = { ...current, policy: await editFacetRefList(cwd, 'policies', current.policy, ctx) };
    }
    assertExecProviderEffort(current.provider, current.model, current.effort, `exec.${current.name}.effort`);
    if (!shouldKeepSetupMenuOpen()) {
      return current;
    }
  }
}

async function editActorList(
  cwd: string,
  label: string,
  actors: ExecActorConfig[],
  template: ExecActorConfig,
  ctx: ExecSessionContext,
): Promise<ExecActorConfig[]> {
  let current = actors;
  while (true) {
    const action = await selectOption<string>(label, [
      ...current.map((actor, index) => ({
        label: `${sanitizeTerminalText(actor.name)}: ${formatActorDetails(actor)}`,
        value: `edit:${index}`,
      })),
      { label: 'Add', value: 'add' },
      { label: 'Delete', value: 'delete' },
      { label: 'Back', value: 'back' },
    ]);
    if (action === null || action === 'back') {
      return current;
    }
    if (action === 'add') {
      const actorName = buildNextActorName(label, current);
      assertExecActorName(actorName, `${label}.name`);
      current = [...current, { ...template, name: actorName }];
    } else if (action === 'delete') {
      if (current.length === 1) {
        info(`${label} must contain at least one entry.`);
      } else {
        const selected = await selectOption<string>(`Delete ${label}`, current.map((actor, index) => ({
          label: sanitizeTerminalText(actor.name),
          value: String(index),
        })));
        if (selected !== null) {
          current = current.filter((_, index) => index !== Number(selected));
        }
      }
    } else if (action.startsWith('edit:')) {
      const index = Number(action.slice('edit:'.length));
      const actor = current[index];
      if (!actor) {
        throw new Error(`Invalid ${label} index: ${index}`);
      }
      const updated = await editActor(cwd, actor, template, ctx);
      current = current.map((entry, entryIndex) => entryIndex === index ? updated : entry);
    }
    if (!shouldKeepSetupMenuOpen()) {
      return current;
    }
  }
}

async function editReplanConfig(cwd: string, config: ExecConfig, ctx: ExecSessionContext): Promise<ExecConfig> {
  let current = config;
  while (true) {
    const field = await selectOption<'instruction' | 'knowledge' | 'policy' | 'back'>('Replan settings', [
      { label: `Instruction: ${sanitizeTerminalText(current.replan.instruction)}`, value: 'instruction' },
      { label: `Knowledge: ${formatFacetListForTerminal(current.replan.knowledge)}`, value: 'knowledge' },
      { label: `Policy: ${formatFacetListForTerminal(current.replan.policy)}`, value: 'policy' },
      { label: 'Back', value: 'back' },
    ]);
    if (field === null || field === 'back') {
      return current;
    }
    if (field === 'instruction') {
      current = {
        ...current,
        replan: {
          ...current.replan,
          instruction: await editInstructionFacetRef(cwd, current.replan.instruction, DEFAULT_EXEC_CONFIG.replan.instruction, ctx),
        },
      };
    }
    if (field === 'knowledge') {
      current = { ...current, replan: { ...current.replan, knowledge: await editFacetRefList(cwd, 'knowledge', current.replan.knowledge, ctx) } };
    }
    if (field === 'policy') {
      current = { ...current, replan: { ...current.replan, policy: await editFacetRefList(cwd, 'policies', current.replan.policy, ctx) } };
    }
    if (!shouldKeepSetupMenuOpen()) {
      return current;
    }
  }
}

async function editLoopConfig(config: ExecConfig, lang: ExecSessionContext['lang']): Promise<ExecConfig> {
  let current = config;
  while (true) {
    const field = await selectOption<'small' | 'large' | 'max' | 'back'>('Loop settings', [
      { label: `Small loop threshold: ${current.loop.smallThreshold}`, value: 'small' },
      { label: `Large loop threshold: ${current.loop.largeThreshold}`, value: 'large' },
      { label: `Max steps: ${current.loop.maxSteps}`, value: 'max' },
      { label: 'Back', value: 'back' },
    ]);
    if (field === null || field === 'back') {
      return current;
    }
    if (field === 'small') {
      current = { ...current, loop: { ...current.loop, smallThreshold: await promptInteger('Small loop threshold', current.loop.smallThreshold, lang) } };
    }
    if (field === 'large') {
      current = { ...current, loop: { ...current.loop, largeThreshold: await promptInteger('Large loop threshold', current.loop.largeThreshold, lang) } };
    }
    if (field === 'max') {
      current = { ...current, loop: { ...current.loop, maxSteps: await promptInteger('Max steps', current.loop.maxSteps, lang) } };
    }
    if (!shouldKeepSetupMenuOpen()) {
      return current;
    }
  }
}

export async function runSetupMenu(cwd: string, config: ExecConfig, ctx: ExecSessionContext): Promise<ExecConfig> {
  const workerTemplate = DEFAULT_EXEC_CONFIG.workers[0];
  const judgeTemplate = DEFAULT_EXEC_CONFIG.judges[0];
  if (!workerTemplate || !judgeTemplate) {
    throw new Error('Default exec actor templates are missing.');
  }
  let current = config;
  let setupCtx = ctx;
  if (!shouldKeepSetupMenuOpen()) {
    await selectOption<SetupSection>('Team Configuration', buildSetupSectionOptions(current));
    return current;
  }
  while (true) {
    const section = await selectOption<SetupSection>('Team Configuration', buildSetupSectionOptions(current));
    if (section === null || section === 'back') {
      return current;
    }
    try {
      const next = await resolveSetupSection(cwd, section, current, workerTemplate, judgeTemplate, setupCtx);
      assertExecConfig(next);
      const nextSessionId = shouldKeepExecSession(current.session, next.session) ? setupCtx.sessionId : undefined;
      setupCtx = createExecSessionContext(cwd, next, nextSessionId);
      current = next;
    } catch (error) {
      if (error instanceof ProjectBoundaryError) {
        throw error;
      }
      info(sanitizeTerminalText(error instanceof Error ? error.message : String(error)));
    }
    if (!shouldKeepSetupMenuOpen()) {
      return current;
    }
  }
}

async function resolveSetupSection(
  cwd: string,
  section: SetupSection | null,
  config: ExecConfig,
  workerTemplate: ExecActorConfig,
  judgeTemplate: ExecActorConfig,
  ctx: ExecSessionContext,
): Promise<ExecConfig> {
  if (section === 'assistant') {
    return { ...config, session: await editSessionConfig(config.session, ctx.lang) };
  }
  if (section === 'workers') {
    return { ...config, workers: await editActorList(cwd, 'Workers', config.workers, workerTemplate, ctx) };
  }
  if (section === 'judges') {
    return { ...config, judges: await editActorList(cwd, 'Judges', config.judges, judgeTemplate, ctx) };
  }
  if (section === 'replan') {
    return editReplanConfig(cwd, config, ctx);
  }
  if (section === 'loop') {
    return editLoopConfig(config, ctx.lang);
  }
  if (section === 'preset') {
    return editPresetSetup(cwd, config, ctx.lang);
  }
  return config;
}
