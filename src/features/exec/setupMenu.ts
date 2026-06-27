import type { ProviderType } from '../../infra/providers/index.js';
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
import { execCurrentLabel, execLabel, type ExecLanguage } from './labels.js';
import { editPresetSetup } from './presetSetup.js';
import { promptInteger, promptText, selectExecOption } from './promptUtils.js';
import { ProjectBoundaryError } from './projectLocalFiles.js';
import {
  createExecSessionContext,
  shouldKeepExecSession,
  type ExecSessionContext,
} from './assistantSession.js';
import type { ExecActorConfig, ExecConfig, ExecEffort, ExecSessionConfig } from './types.js';

type SetupSection = 'assistant' | 'workers' | 'judges' | 'replan' | 'loop' | 'preset' | 'back';
type SetupSectionOption = { label: string; value: SetupSection };
type ActorListKind = 'workers' | 'judges';
const CUSTOM_MODEL_VALUE = '__custom_model__';

function supportsAnyExecEffort(provider: ProviderType): boolean {
  return getSupportedExecEfforts(provider).length > 0;
}

function shouldKeepSetupMenuOpen(): boolean {
  return resolveTtyPolicy().useTty && !process.stdin.readableEnded;
}

function buildSetupSectionOptions(current: ExecConfig, lang: ExecLanguage): SetupSectionOption[] {
  return [
    {
      label: execLabel(lang, 'setup.assistantSummary', {
        summary: `${formatProviderModel(current.session.provider, current.session.model, lang)}/${sanitizeTerminalText(current.session.effort ?? execLabel(lang, 'common.none'))}`,
      }),
      value: 'assistant',
    },
    { label: execLabel(lang, 'setup.workersSummary', { count: String(current.workers.length) }), value: 'workers' },
    { label: execLabel(lang, 'setup.judgesSummary', { count: String(current.judges.length) }), value: 'judges' },
    { label: execLabel(lang, 'setup.replanSummary', { instruction: sanitizeTerminalText(current.replan.instruction) }), value: 'replan' },
    {
      label: execLabel(lang, 'setup.loopSummary', {
        small: String(current.loop.smallThreshold),
        large: String(current.loop.largeThreshold),
        max: String(current.loop.maxSteps),
      }),
      value: 'loop',
    },
    { label: execLabel(lang, 'setup.preset'), value: 'preset' },
    { label: execLabel(lang, 'common.back'), value: 'back' },
  ];
}

function formatFacetListForTerminal(values: string[], lang: ExecLanguage): string {
  return values.length > 0 ? values.map((value) => sanitizeTerminalText(value)).join(', ') : execLabel(lang, 'common.none');
}

function buildNextActorName(prefix: 'worker' | 'judge', actors: ExecActorConfig[]): string {
  const existingNames = new Set(actors.map((actor) => actor.name));
  for (let index = 1; index <= actors.length + 1; index += 1) {
    const candidate = `${prefix}-${index}`;
    if (!existingNames.has(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Unable to allocate ${prefix} actor name.`);
}

async function selectProvider(current: ProviderType, lang: ExecLanguage): Promise<ProviderType> {
  const selected = await selectExecOption<ProviderType>(lang, execLabel(lang, 'settings.provider'), EXEC_PROVIDERS.map((provider) => ({
    label: provider === current ? execCurrentLabel(lang, provider) : provider,
    value: provider,
  })));
  return selected ?? current;
}

async function selectEffort(provider: ProviderType, current: ExecEffort | undefined, lang: ExecLanguage): Promise<ExecEffort | undefined> {
  const efforts = getSupportedExecEfforts(provider);
  if (efforts.length === 0) {
    throw new Error(`Provider "${provider}" does not support exec effort selection.`);
  }
  const selected = await selectExecOption<ExecEffort>(lang, execLabel(lang, 'settings.effort'), efforts.map((effort) => ({
    label: effort === current ? execCurrentLabel(lang, effort) : effort,
    value: effort,
  })));
  if (selected === null) {
    return current;
  }
  return selected;
}

function formatModelValue(model: string | undefined, lang: ExecLanguage): string {
  return model === undefined ? execLabel(lang, 'common.providerDefault') : sanitizeTerminalText(model);
}

function requireCustomModelInput(model: string, lang: ExecLanguage): string {
  if (model.trim().length === 0) {
    throw new Error(execLabel(lang, 'settings.customModelRequired'));
  }
  return model;
}

async function selectModel(provider: ProviderType, current: string | undefined, lang: ExecLanguage): Promise<string | undefined> {
  const candidates = [...new Set([
    ...getExecModelCandidates(provider),
    ...(current !== undefined ? [current] : []),
  ])];
  const selected = await selectExecOption<string>(lang, execLabel(lang, 'settings.model'), [
    ...candidates.map((model) => ({
      label: model === current ? execCurrentLabel(lang, sanitizeTerminalText(model)) : sanitizeTerminalText(model),
      value: model,
    })),
    { label: execLabel(lang, 'settings.customModel'), value: CUSTOM_MODEL_VALUE },
  ]);
  if (selected === null) {
    return current;
  }
  if (selected === CUSTOM_MODEL_VALUE) {
    const model = await promptText(execLabel(lang, 'settings.customModelPrompt'), current ?? '', lang);
    return requireCustomModelInput(model, lang);
  }
  return selected;
}

async function editSessionConfig(session: ExecSessionConfig, lang: ExecLanguage): Promise<ExecSessionConfig> {
  let current = session;
  while (true) {
    const options: Array<{ label: string; value: 'provider' | 'model' | 'effort' | 'back' }> = [
      { label: execLabel(lang, 'fields.provider', { value: sanitizeTerminalText(current.provider) }), value: 'provider' },
      { label: execLabel(lang, 'fields.model', { value: formatModelValue(current.model, lang) }), value: 'model' },
    ];
    if (supportsAnyExecEffort(current.provider)) {
      options.push({
        label: execLabel(lang, 'fields.effort', { value: sanitizeTerminalText(current.effort ?? execLabel(lang, 'common.none')) }),
        value: 'effort',
      });
    }
    options.push({ label: execLabel(lang, 'common.back'), value: 'back' });
    const field = await selectExecOption<'provider' | 'model' | 'effort' | 'back'>(lang, execLabel(lang, 'settings.assistant'), options);
    if (field === null || field === 'back') {
      return current;
    }
    if (field === 'provider') {
      const provider = await selectProvider(current.provider, lang);
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
      current = { ...current, effort: await selectEffort(current.provider, current.effort, lang) };
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
      { label: execLabel(ctx.lang, 'fields.name', { value: sanitizeTerminalText(current.name) }), value: 'name' },
      { label: execLabel(ctx.lang, 'fields.provider', { value: sanitizeTerminalText(current.provider) }), value: 'provider' },
      { label: execLabel(ctx.lang, 'fields.model', { value: formatModelValue(current.model, ctx.lang) }), value: 'model' },
    ];
    if (supportsAnyExecEffort(current.provider)) {
      options.push({
        label: execLabel(ctx.lang, 'fields.effort', { value: sanitizeTerminalText(current.effort ?? execLabel(ctx.lang, 'common.none')) }),
        value: 'effort',
      });
    }
    options.push(
      { label: execLabel(ctx.lang, 'fields.instruction', { value: sanitizeTerminalText(current.instruction) }), value: 'instruction' },
      { label: execLabel(ctx.lang, 'fields.knowledge', { value: formatFacetListForTerminal(current.knowledge, ctx.lang) }), value: 'knowledge' },
      { label: execLabel(ctx.lang, 'fields.policy', { value: formatFacetListForTerminal(current.policy, ctx.lang) }), value: 'policy' },
      { label: execLabel(ctx.lang, 'common.back'), value: 'back' },
    );
    const field = await selectExecOption<'name' | 'provider' | 'model' | 'effort' | 'instruction' | 'knowledge' | 'policy' | 'back'>(
      ctx.lang,
      execLabel(ctx.lang, 'settings.actor', { name: sanitizeTerminalText(current.name) }),
      options,
    );
    if (field === null || field === 'back') {
      return current;
    }
    if (field === 'name') {
      const name = await promptText(execLabel(ctx.lang, 'settings.name'), current.name, ctx.lang);
      assertExecActorName(name, `exec.${current.name}.name`);
      current = { ...current, name };
    }
    if (field === 'provider') {
      const provider = await selectProvider(current.provider, ctx.lang);
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
      current = { ...current, effort: await selectEffort(current.provider, current.effort, ctx.lang) };
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
  kind: ActorListKind,
  actors: ExecActorConfig[],
  template: ExecActorConfig,
  ctx: ExecSessionContext,
): Promise<ExecActorConfig[]> {
  const label = execLabel(ctx.lang, `actors.${kind}`);
  const actorNamePrefix = kind === 'workers' ? 'worker' : 'judge';
  let current = actors;
  while (true) {
    const action = await selectExecOption<string>(ctx.lang, label, [
      ...current.map((actor, index) => ({
        label: `${sanitizeTerminalText(actor.name)}: ${formatActorDetails(actor, ctx.lang)}`,
        value: `edit:${index}`,
      })),
      { label: execLabel(ctx.lang, 'common.add'), value: 'add' },
      { label: execLabel(ctx.lang, 'common.delete'), value: 'delete' },
      { label: execLabel(ctx.lang, 'common.back'), value: 'back' },
    ]);
    if (action === null || action === 'back') {
      return current;
    }
    if (action === 'add') {
      const actorName = buildNextActorName(actorNamePrefix, current);
      assertExecActorName(actorName, `${label}.name`);
      current = [...current, { ...template, name: actorName }];
    } else if (action === 'delete') {
      if (current.length === 1) {
        info(execLabel(ctx.lang, 'actors.mustContainOne', { label }));
      } else {
        const selected = await selectExecOption<string>(ctx.lang, execLabel(ctx.lang, 'actors.deletePrompt', { label }), current.map((actor, index) => ({
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
        throw new Error(execLabel(ctx.lang, 'actors.invalidIndex', { label, index: String(index) }));
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
    const field = await selectExecOption<'instruction' | 'knowledge' | 'policy' | 'back'>(ctx.lang, execLabel(ctx.lang, 'replan.settings'), [
      { label: execLabel(ctx.lang, 'fields.instruction', { value: sanitizeTerminalText(current.replan.instruction) }), value: 'instruction' },
      { label: execLabel(ctx.lang, 'fields.knowledge', { value: formatFacetListForTerminal(current.replan.knowledge, ctx.lang) }), value: 'knowledge' },
      { label: execLabel(ctx.lang, 'fields.policy', { value: formatFacetListForTerminal(current.replan.policy, ctx.lang) }), value: 'policy' },
      { label: execLabel(ctx.lang, 'common.back'), value: 'back' },
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

async function editLoopConfig(config: ExecConfig, lang: ExecLanguage): Promise<ExecConfig> {
  let current = config;
  while (true) {
    const field = await selectExecOption<'small' | 'large' | 'max' | 'back'>(lang, execLabel(lang, 'loop.settings'), [
      { label: execLabel(lang, 'fields.smallLoopThreshold', { value: String(current.loop.smallThreshold) }), value: 'small' },
      { label: execLabel(lang, 'fields.largeLoopThreshold', { value: String(current.loop.largeThreshold) }), value: 'large' },
      { label: execLabel(lang, 'fields.maxSteps', { value: String(current.loop.maxSteps) }), value: 'max' },
      { label: execLabel(lang, 'common.back'), value: 'back' },
    ]);
    if (field === null || field === 'back') {
      return current;
    }
    if (field === 'small') {
      current = { ...current, loop: { ...current.loop, smallThreshold: await promptInteger(execLabel(lang, 'loop.smallThresholdPrompt'), current.loop.smallThreshold, lang) } };
    }
    if (field === 'large') {
      current = { ...current, loop: { ...current.loop, largeThreshold: await promptInteger(execLabel(lang, 'loop.largeThresholdPrompt'), current.loop.largeThreshold, lang) } };
    }
    if (field === 'max') {
      current = { ...current, loop: { ...current.loop, maxSteps: await promptInteger(execLabel(lang, 'loop.maxStepsPrompt'), current.loop.maxSteps, lang) } };
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
    await selectExecOption<SetupSection>(setupCtx.lang, execLabel(setupCtx.lang, 'setup.teamConfiguration'), buildSetupSectionOptions(current, setupCtx.lang));
    return current;
  }
  while (true) {
    const section = await selectExecOption<SetupSection>(setupCtx.lang, execLabel(setupCtx.lang, 'setup.teamConfiguration'), buildSetupSectionOptions(current, setupCtx.lang));
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
    return { ...config, workers: await editActorList(cwd, 'workers', config.workers, workerTemplate, ctx) };
  }
  if (section === 'judges') {
    return { ...config, judges: await editActorList(cwd, 'judges', config.judges, judgeTemplate, ctx) };
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
