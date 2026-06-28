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
  normalizeExecConfigEfforts,
  resolveEffortAfterProviderModelOverride,
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
import {
  resolveExecConfigProviderModel,
  resolveExecProviderModel,
  type ExecProviderModelDefaults,
} from './runtimeConfig.js';
import type {
  ExecActorConfig,
  ExecConfig,
  ExecEffort,
  ExecSessionConfig,
  ResolvedExecActorConfig,
  ResolvedExecConfig,
  ResolvedExecSessionConfig,
} from './types.js';

type SetupSection = 'assistant' | 'workers' | 'reviews' | 'replan' | 'loop' | 'preset' | 'back';
type SetupSectionOption = { label: string; value: SetupSection };
type ActorListKind = 'workers' | 'reviews';
type ModelSelection = { changed: false } | { changed: true; model: string | undefined };
const CUSTOM_MODEL_VALUE = '__custom_model__';
const DEFAULT_MODEL_VALUE = '__default_model__';
const DEFAULT_EFFORT_VALUE = '__default_effort__';

function supportsAnyExecEffort(provider: ProviderType): boolean {
  return getSupportedExecEfforts(provider).length > 0;
}

function shouldKeepSetupMenuOpen(): boolean {
  return resolveTtyPolicy().useTty && !process.stdin.readableEnded;
}

function buildSetupSectionOptions(current: ResolvedExecConfig, lang: ExecLanguage): SetupSectionOption[] {
  return [
    {
      label: execLabel(lang, 'setup.assistantSummary', {
        summary: `${formatProviderModel(current.session.provider, current.session.model, lang)}/${sanitizeTerminalText(current.session.effort ?? execLabel(lang, 'common.none'))}`,
      }),
      value: 'assistant',
    },
    { label: execLabel(lang, 'setup.workersSummary', { count: String(current.workers.length) }), value: 'workers' },
    { label: execLabel(lang, 'setup.reviewsSummary', { count: String(current.reviews.length) }), value: 'reviews' },
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

function buildNextActorName(prefix: 'worker' | 'review', actors: ExecActorConfig[]): string {
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
  const defaultLabel = execLabel(lang, 'settings.defaultEffort');
  const selected = await selectExecOption<ExecEffort | typeof DEFAULT_EFFORT_VALUE>(lang, execLabel(lang, 'settings.effort'), [
    {
      label: current === undefined ? execCurrentLabel(lang, defaultLabel) : defaultLabel,
      value: DEFAULT_EFFORT_VALUE,
    },
    ...efforts.map((effort) => ({
      label: effort === current ? execCurrentLabel(lang, effort) : effort,
      value: effort,
    })),
  ]);
  if (selected === null) {
    return current;
  }
  if (selected === DEFAULT_EFFORT_VALUE) {
    return undefined;
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

async function selectModel(
  provider: ProviderType,
  rawCurrent: string | undefined,
  effectiveCurrent: string | undefined,
  lang: ExecLanguage,
): Promise<ModelSelection> {
  const candidates = [...new Set([
    ...getExecModelCandidates(provider),
    ...(rawCurrent !== undefined ? [rawCurrent] : []),
    ...(effectiveCurrent !== undefined ? [effectiveCurrent] : []),
  ])];
  const defaultLabel = execLabel(lang, 'settings.defaultModel', { value: execLabel(lang, 'common.providerDefault') });
  const selected = await selectExecOption<string>(lang, execLabel(lang, 'settings.model'), [
    {
      label: rawCurrent === undefined ? execCurrentLabel(lang, defaultLabel) : defaultLabel,
      value: DEFAULT_MODEL_VALUE,
    },
    ...candidates.map((model) => ({
      label: model === rawCurrent ? execCurrentLabel(lang, sanitizeTerminalText(model)) : sanitizeTerminalText(model),
      value: model,
    })),
    { label: execLabel(lang, 'settings.customModel'), value: CUSTOM_MODEL_VALUE },
  ]);
  if (selected === null) {
    return { changed: false };
  }
  if (selected === DEFAULT_MODEL_VALUE) {
    return { changed: true, model: undefined };
  }
  if (selected === CUSTOM_MODEL_VALUE) {
    const model = await promptText(execLabel(lang, 'settings.customModelPrompt'), rawCurrent ?? effectiveCurrent ?? '', lang);
    return { changed: true, model: requireCustomModelInput(model, lang) };
  }
  return { changed: true, model: selected };
}

async function editSessionConfig(
  session: ExecSessionConfig,
  effectiveSession: ResolvedExecSessionConfig,
  providerModelDefaults: ExecProviderModelDefaults,
  lang: ExecLanguage,
): Promise<ExecSessionConfig> {
  let current = effectiveSession;
  let raw = session;
  while (true) {
    const options: Array<{ label: string; value: 'provider' | 'model' | 'effort' | 'back' }> = [
      { label: execLabel(lang, 'fields.provider', { value: sanitizeTerminalText(current.provider) }), value: 'provider' },
      { label: execLabel(lang, 'fields.model', { value: formatModelValue(raw.model, lang) }), value: 'model' },
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
      return raw;
    }
    if (field === 'provider') {
      const provider = await selectProvider(current.provider, lang);
      if (provider !== current.provider) {
        const model = resolveModelAfterProviderOverride(current.provider, provider, current.model, undefined);
        const nextResolvedProviderModel = resolveExecProviderModel(provider, model, providerModelDefaults, 'exec.session.provider');
        current = {
          ...current,
          ...nextResolvedProviderModel,
          effort: resolveEffortAfterProviderModelOverride(
            current.provider,
            current.model,
            nextResolvedProviderModel.provider,
            nextResolvedProviderModel.model,
            current.effort,
          ),
        };
        raw = { ...raw, provider, model, effort: current.effort };
      }
    }
    if (field === 'model') {
      const selection = await selectModel(current.provider, raw.model, current.model, lang);
      if (selection.changed) {
        const nextResolvedProviderModel = resolveExecProviderModel(raw.provider, selection.model, providerModelDefaults, 'exec.session.provider');
        const effort = resolveEffortAfterProviderModelOverride(
          current.provider,
          current.model,
          nextResolvedProviderModel.provider,
          nextResolvedProviderModel.model,
          current.effort,
        );
        current = { ...current, ...nextResolvedProviderModel, effort };
        raw = { ...raw, model: selection.model, effort };
      }
    }
    if (field === 'effort') {
      current = { ...current, effort: await selectEffort(current.provider, current.effort, lang) };
      raw = { ...raw, effort: current.effort };
    }
    assertExecProviderEffort(current.provider, current.model, current.effort, 'exec.session.effort');
    if (!shouldKeepSetupMenuOpen()) {
      return raw;
    }
  }
}

async function editActor(
  cwd: string,
  actor: ExecActorConfig,
  effectiveActor: ResolvedExecActorConfig,
  defaultActor: ExecActorConfig,
  ctx: ExecSessionContext,
  providerModelDefaults: ExecProviderModelDefaults,
): Promise<ExecActorConfig> {
  let current = effectiveActor;
  let raw = actor;
  while (true) {
    const options: Array<{
      label: string;
      value: 'name' | 'provider' | 'model' | 'effort' | 'instruction' | 'knowledge' | 'policy' | 'back';
    }> = [
      { label: execLabel(ctx.lang, 'fields.name', { value: sanitizeTerminalText(current.name) }), value: 'name' },
      { label: execLabel(ctx.lang, 'fields.provider', { value: sanitizeTerminalText(current.provider) }), value: 'provider' },
      { label: execLabel(ctx.lang, 'fields.model', { value: formatModelValue(raw.model, ctx.lang) }), value: 'model' },
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
      return raw;
    }
    if (field === 'name') {
      const name = await promptText(execLabel(ctx.lang, 'settings.name'), current.name, ctx.lang);
      assertExecActorName(name, `exec.${current.name}.name`);
      raw = { ...raw, name };
      current = { ...current, name };
    }
    if (field === 'provider') {
      const provider = await selectProvider(current.provider, ctx.lang);
      if (provider !== current.provider) {
        const model = resolveModelAfterProviderOverride(current.provider, provider, current.model, undefined);
        const nextResolvedProviderModel = resolveExecProviderModel(provider, model, providerModelDefaults, `exec.${current.name}.provider`);
        current = {
          ...current,
          ...nextResolvedProviderModel,
          effort: resolveEffortAfterProviderModelOverride(
            current.provider,
            current.model,
            nextResolvedProviderModel.provider,
            nextResolvedProviderModel.model,
            current.effort,
          ),
        };
        raw = { ...raw, provider, model, effort: current.effort };
      }
    }
    if (field === 'model') {
      const selection = await selectModel(current.provider, raw.model, current.model, ctx.lang);
      if (selection.changed) {
        const nextResolvedProviderModel = resolveExecProviderModel(raw.provider, selection.model, providerModelDefaults, `exec.${current.name}.provider`);
        const effort = resolveEffortAfterProviderModelOverride(
          current.provider,
          current.model,
          nextResolvedProviderModel.provider,
          nextResolvedProviderModel.model,
          current.effort,
        );
        current = { ...current, ...nextResolvedProviderModel, effort };
        raw = { ...raw, model: selection.model, effort };
      }
    }
    if (field === 'effort') {
      current = { ...current, effort: await selectEffort(current.provider, current.effort, ctx.lang) };
      raw = { ...raw, effort: current.effort };
    }
    if (field === 'instruction') {
      const instruction = await editInstructionFacetRef(cwd, current.instruction, defaultActor.instruction, ctx);
      raw = {
        ...raw,
        instruction,
      };
      current = {
        ...current,
        instruction,
      };
    }
    if (field === 'knowledge') {
      const knowledge = await editFacetRefList(cwd, 'knowledge', current.knowledge, ctx);
      raw = { ...raw, knowledge };
      current = { ...current, knowledge };
    }
    if (field === 'policy') {
      const policy = await editFacetRefList(cwd, 'policies', current.policy, ctx);
      raw = { ...raw, policy };
      current = { ...current, policy };
    }
    assertExecProviderEffort(current.provider, current.model, current.effort, `exec.${current.name}.effort`);
    if (!shouldKeepSetupMenuOpen()) {
      return raw;
    }
  }
}

async function editActorList(
  cwd: string,
  kind: ActorListKind,
  config: ExecConfig,
  template: ExecActorConfig,
  ctx: ExecSessionContext,
  providerModelDefaults: ExecProviderModelDefaults,
): Promise<ExecActorConfig[]> {
  const label = execLabel(ctx.lang, `actors.${kind}`);
  const actorNamePrefix = kind === 'workers' ? 'worker' : 'review';
  let current = config[kind];
  while (true) {
    const effectiveActors = resolveExecConfigProviderModel({ ...config, [kind]: current }, providerModelDefaults)[kind];
    const action = await selectExecOption<string>(ctx.lang, label, [
      ...effectiveActors.map((actor, index) => ({
        label: `${sanitizeTerminalText(current[index]?.name ?? actor.name)}: ${formatActorDetails(actor, ctx.lang)}`,
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
      const effectiveActor = effectiveActors[index];
      if (!actor) {
        throw new Error(execLabel(ctx.lang, 'actors.invalidIndex', { label, index: String(index) }));
      }
      if (!effectiveActor) {
        throw new Error(execLabel(ctx.lang, 'actors.invalidIndex', { label, index: String(index) }));
      }
      const updated = await editActor(cwd, actor, effectiveActor, template, ctx, providerModelDefaults);
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

export async function runSetupMenu(
  cwd: string,
  config: ExecConfig,
  ctx: ExecSessionContext,
  providerModelDefaults: ExecProviderModelDefaults,
): Promise<ExecConfig> {
  const workerTemplate = DEFAULT_EXEC_CONFIG.workers[0];
  const reviewTemplate = DEFAULT_EXEC_CONFIG.reviews[0];
  if (!workerTemplate || !reviewTemplate) {
    throw new Error('Default exec actor templates are missing.');
  }
  let current = config;
  let setupCtx = ctx;
  if (!shouldKeepSetupMenuOpen()) {
    const runtimeConfig = resolveExecConfigProviderModel(current, providerModelDefaults);
    await selectExecOption<SetupSection>(setupCtx.lang, execLabel(setupCtx.lang, 'setup.teamConfiguration'), buildSetupSectionOptions(runtimeConfig, setupCtx.lang));
    return current;
  }
  while (true) {
    const runtimeConfig = resolveExecConfigProviderModel(current, providerModelDefaults);
    const section = await selectExecOption<SetupSection>(setupCtx.lang, execLabel(setupCtx.lang, 'setup.teamConfiguration'), buildSetupSectionOptions(runtimeConfig, setupCtx.lang));
    if (section === null || section === 'back') {
      return current;
    }
    try {
      const next = normalizeExecConfigEfforts(
        await resolveSetupSection(cwd, section, current, runtimeConfig, workerTemplate, reviewTemplate, setupCtx, providerModelDefaults),
        providerModelDefaults,
      );
      assertExecConfig(next);
      const nextRuntimeConfig = resolveExecConfigProviderModel(next, providerModelDefaults);
      const nextSessionId = shouldKeepExecSession(runtimeConfig.session, nextRuntimeConfig.session) ? setupCtx.sessionId : undefined;
      setupCtx = createExecSessionContext(cwd, nextRuntimeConfig, nextSessionId);
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
  runtimeConfig: ResolvedExecConfig,
  workerTemplate: ExecActorConfig,
  reviewTemplate: ExecActorConfig,
  ctx: ExecSessionContext,
  providerModelDefaults: ExecProviderModelDefaults,
): Promise<ExecConfig> {
  if (section === 'assistant') {
    return { ...config, session: await editSessionConfig(config.session, runtimeConfig.session, providerModelDefaults, ctx.lang) };
  }
  if (section === 'workers') {
    return { ...config, workers: await editActorList(cwd, 'workers', config, workerTemplate, ctx, providerModelDefaults) };
  }
  if (section === 'reviews') {
    return { ...config, reviews: await editActorList(cwd, 'reviews', config, reviewTemplate, ctx, providerModelDefaults) };
  }
  if (section === 'replan') {
    return editReplanConfig(cwd, config, ctx);
  }
  if (section === 'loop') {
    return editLoopConfig(config, ctx.lang);
  }
  if (section === 'preset') {
    return editPresetSetup(cwd, config, ctx.lang, providerModelDefaults);
  }
  return config;
}
