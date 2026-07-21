import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getGlobalFacetDir, getProjectFacetDir, getRepertoireDir } from '../../infra/config/paths.js';
import {
  isResourcePath,
  resolveFacetPath,
  resolveResourceContentWithSource,
} from '../../infra/config/loaders/resource-resolver.js';
import { isScopeRef } from 'faceted-prompting';
import { getFacetDirs, scanFacets, type FacetLookupConfig, type FacetType } from '../catalog/catalogFacets.js';
import { readInteractiveInput } from '../interactive/interactiveInput.js';
import { info } from '../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../shared/utils/index.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import { askExecAssistant, type ExecSessionContext } from './assistantSession.js';
import { EXEC_TEXT_INPUT_COMMAND_AVAILABILITY } from './commandAvailability.js';
import { execFacetKindLabel, execLabel, execScopeLabel, execSourceLabel, type ExecLanguage } from './labels.js';
import { promptText, selectExecOption, selectMultipleExecOptions } from './promptUtils.js';
import {
  projectLocalFileExists,
  readProjectLocalTextFile,
  writeProjectLocalTextFile,
} from './projectLocalFiles.js';

type WritableFacetScope = 'project' | 'global';
type InstructionFacetAction = 'select' | 'ai_edit' | 'create_ai' | 'edit_editor' | 'default' | 'back';
type FacetListAction = 'toggle' | 'create_editor' | 'create_ai' | 'clear' | 'back';

const FACET_NAME_REGEX = /^[A-Za-z0-9_-]+$/;

function validateFacetName(name: string): string {
  if (!FACET_NAME_REGEX.test(name)) {
    throw new Error(`Invalid facet name: ${name}`);
  }
  return name;
}

function normalizeFacetEntries(
  kind: FacetType,
  cwd: string,
  lookupConfig: FacetLookupConfig,
): ReturnType<typeof scanFacets> {
  const effective = new Map<string, ReturnType<typeof scanFacets>[number]>();
  for (const entry of scanFacets(kind, cwd, lookupConfig)) {
    effective.set(entry.name, entry);
  }
  return [...effective.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function getWritableFacetDir(cwd: string, kind: FacetType, source: WritableFacetScope): string {
  switch (source) {
    case 'project':
      return getProjectFacetDir(cwd, kind);
    case 'global':
      return getGlobalFacetDir(kind);
  }
  const exhaustive: never = source;
  throw new Error(`Unsupported facet write scope: ${exhaustive}`);
}

function readEffectiveFacetContent(
  cwd: string,
  kind: FacetType,
  name: string,
  lookupConfig: FacetLookupConfig,
): string {
  const facetName = validateFacetName(name);
  const candidates = [...getFacetDirs(kind, cwd, lookupConfig)]
    .reverse()
    .map((entry) => ({
      source: entry.source,
      path: join(entry.dir, `${facetName}.md`),
    }));

  for (const candidate of candidates) {
    if (candidate.source === 'project') {
      if (projectLocalFileExists(cwd, candidate.path, `${kind} facet`)) {
        return readProjectLocalTextFile(cwd, candidate.path, `${kind} facet`);
      }
      continue;
    }
    if (existsSync(candidate.path)) {
      return readFileSync(candidate.path, 'utf-8');
    }
  }
  throw new Error(`${kind} facet not found: ${facetName}`);
}

function writeFacetFile(cwd: string, kind: FacetType, scope: WritableFacetScope, name: string, content: string): string {
  const facetName = validateFacetName(name);
  const facetDir = getWritableFacetDir(cwd, kind, scope);
  const facetPath = join(facetDir, `${facetName}.md`);
  const alreadyExists = scope === 'project'
    ? projectLocalFileExists(cwd, facetPath, `${kind} facet`)
    : existsSync(facetPath);
  if (alreadyExists) {
    throw new Error(`${scope} ${kind} facet already exists: ${facetName}`);
  }
  if (content.trim().length === 0) {
    throw new Error(`${kind} facet content is required.`);
  }
  if (scope === 'project') {
    writeProjectLocalTextFile(cwd, facetPath, content, `${kind} facet`);
    return facetName;
  }
  mkdirSync(facetDir, { recursive: true });
  writeFileSync(facetPath, content, 'utf-8');
  return facetName;
}

function overwriteFacetFile(cwd: string, kind: FacetType, scope: WritableFacetScope, name: string, content: string): string {
  const facetName = validateFacetName(name);
  const facetDir = getWritableFacetDir(cwd, kind, scope);
  if (content.trim().length === 0) {
    throw new Error(`${kind} facet content is required.`);
  }
  if (scope === 'project') {
    writeProjectLocalTextFile(cwd, join(facetDir, `${facetName}.md`), content, `${kind} facet`);
    return facetName;
  }
  mkdirSync(facetDir, { recursive: true });
  writeFileSync(join(facetDir, `${facetName}.md`), content, 'utf-8');
  return facetName;
}

async function selectExistingFacet(kind: FacetType, cwd: string, lookupConfig: FacetLookupConfig, lang: ExecLanguage): Promise<string | null> {
  const entries = normalizeFacetEntries(kind, cwd, lookupConfig);
  const selected = await selectExecOption<string>(lang, execLabel(lang, 'facets.selectPrompt', { kind: execFacetKindLabel(lang, kind) }), entries.map((entry) => ({
    label: sanitizeTerminalText(entry.name),
    value: entry.name,
    description: `${sanitizeTerminalText(execSourceLabel(lang, entry.source))} · ${sanitizeTerminalText(entry.description)}`,
  })));
  return selected;
}

async function selectFacetScope(message: string, lang: ExecLanguage): Promise<WritableFacetScope | null> {
  return await selectExecOption<WritableFacetScope>(lang, message, [
    { label: execScopeLabel(lang, 'project'), value: 'project', description: execLabel(lang, 'scope.projectDescription') },
    { label: execScopeLabel(lang, 'global'), value: 'global', description: execLabel(lang, 'scope.globalDescription') },
  ]);
}

function runEditor(initialContent: string, name: string): string {
  const editor = process.env.VISUAL ?? process.env.EDITOR;
  if (!editor) {
    throw new Error('Set VISUAL or EDITOR to edit a facet.');
  }
  const tempDir = mkdtempSync(join(tmpdir(), 'takt-exec-facet-'));
  const tempPath = join(tempDir, `${validateFacetName(name)}.md`);
  try {
    writeFileSync(tempPath, initialContent, 'utf-8');
    const result = spawnSync(editor, [tempPath], { stdio: 'inherit' });
    if (result.status !== null) {
      if (result.status !== 0) {
        throw new Error(`Editor exited with status ${result.status}.`);
      }
    } else if (result.signal !== null) {
      throw new Error(`Editor terminated by signal ${result.signal}.`);
    } else {
      throw new Error('Editor exited without status or signal.');
    }
    return readFileSync(tempPath, 'utf-8');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function confirmGeneratedFacet(kind: FacetType, name: string, content: string, lang: ExecLanguage): Promise<boolean> {
  info(execLabel(lang, 'facets.generated', {
    kind: execFacetKindLabel(lang, kind),
    name: sanitizeTerminalText(name),
  }));
  info(sanitizeTerminalText(content));
  const approved = await selectExecOption<'save' | 'discard'>(lang, execLabel(lang, 'facets.saveGenerated'), [
    { label: execLabel(lang, 'common.save'), value: 'save' },
    { label: execLabel(lang, 'common.discard'), value: 'discard' },
  ]);
  return approved === 'save';
}

async function promptFacetConsultation(kind: FacetType, name: string, ctx: ExecSessionContext): Promise<string | null> {
  const input = await readInteractiveInput(
    execLabel(ctx.lang, 'facets.consultationPrompt', {
      kind: execFacetKindLabel(ctx.lang, kind),
      name: sanitizeTerminalText(name),
    }),
    ctx.lang,
    EXEC_TEXT_INPUT_COMMAND_AVAILABILITY,
  );
  if (input === null) {
    return null;
  }
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function createFacetWithAI(
  cwd: string,
  kind: FacetType,
  scope: WritableFacetScope,
  name: string,
  ctx: ExecSessionContext,
): Promise<string | null> {
  const request = await promptFacetConsultation(kind, name, ctx);
  if (request === null) {
    return null;
  }
  const generated = await askExecAssistant(
    cwd,
    { ...ctx, sessionId: undefined },
    [
      `Create a TAKT ${kind} facet named "${name}".`,
      'Use this user request:',
      request,
      '',
      'Return only markdown content for the facet.',
    ].join('\n'),
    loadTemplate('exec_facet_create', ctx.lang),
  );
  if (!await confirmGeneratedFacet(kind, name, generated.content, ctx.lang)) {
    return null;
  }
  return writeFacetFile(cwd, kind, scope, name, generated.content);
}

async function createFacetRef(cwd: string, kind: FacetType, ctx: ExecSessionContext, useAI: boolean): Promise<string | null> {
  const scope = await selectFacetScope(execLabel(ctx.lang, 'facets.saveScope'), ctx.lang);
  if (scope === null) {
    return null;
  }
  const name = await promptText(execLabel(ctx.lang, 'facets.namePrompt'), 'custom', ctx.lang);
  const ref = useAI
    ? await createFacetWithAI(cwd, kind, scope, name, ctx)
    : writeFacetFile(cwd, kind, scope, name, runEditor(`# ${name}\n\n`, name));
  if (ref !== null) {
    info(execLabel(ctx.lang, 'facets.created', {
      scope: sanitizeTerminalText(execScopeLabel(ctx.lang, scope)),
      kind: execFacetKindLabel(ctx.lang, kind),
      name: sanitizeTerminalText(ref),
    }));
  }
  return ref;
}

async function editFacetWithAI(
  cwd: string,
  kind: FacetType,
  current: string,
  ctx: ExecSessionContext,
): Promise<string | null> {
  const scope = await selectFacetScope(execLabel(ctx.lang, 'facets.editedSaveScope'), ctx.lang);
  if (scope === null) {
    return null;
  }
  const content = readEffectiveFacetContent(cwd, kind, current, ctx.facetLookupConfig);
  const request = await promptFacetConsultation(kind, current, ctx);
  if (request === null) {
    return null;
  }
  const generated = await askExecAssistant(
    cwd,
    { ...ctx, sessionId: undefined },
    [
      `Edit this TAKT ${kind} facet named "${current}".`,
      'Use this user request:',
      request,
      '',
      'Return only the updated markdown content.',
      '',
      content,
    ].join('\n'),
    loadTemplate('exec_facet_edit', ctx.lang),
  );
  if (!await confirmGeneratedFacet(kind, current, generated.content, ctx.lang)) {
    return null;
  }
  return overwriteFacetFile(cwd, kind, scope, current, generated.content);
}

async function editFacetWithEditor(
  cwd: string,
  kind: FacetType,
  current: string,
  ctx: ExecSessionContext,
): Promise<string | null> {
  const scope = await selectFacetScope(execLabel(ctx.lang, 'facets.editedSaveScope'), ctx.lang);
  if (scope === null) {
    return null;
  }
  const edited = runEditor(readEffectiveFacetContent(cwd, kind, current, ctx.facetLookupConfig), current);
  return overwriteFacetFile(cwd, kind, scope, current, edited);
}

export async function editInstructionFacetRef(
  cwd: string,
  current: string,
  defaultRef: string,
  ctx: ExecSessionContext,
): Promise<string> {
  const action = await selectExecOption<InstructionFacetAction>(ctx.lang, execLabel(ctx.lang, 'facets.instructionMenu'), [
    { label: execLabel(ctx.lang, 'facets.selectExisting', { current: sanitizeTerminalText(current) }), value: 'select' },
    { label: execLabel(ctx.lang, 'facets.editWithAI'), value: 'ai_edit' },
    { label: execLabel(ctx.lang, 'facets.createWithAI'), value: 'create_ai' },
    { label: execLabel(ctx.lang, 'facets.openInEditor'), value: 'edit_editor' },
    { label: execLabel(ctx.lang, 'facets.restoreDefault', { defaultRef: sanitizeTerminalText(defaultRef) }), value: 'default' },
    { label: execLabel(ctx.lang, 'common.back'), value: 'back' },
  ]);
  if (action === 'select') {
    return await selectExistingFacet('instructions', cwd, ctx.facetLookupConfig, ctx.lang) ?? current;
  }
  if (action === 'ai_edit') {
    return await editFacetWithAI(cwd, 'instructions', current, ctx) ?? current;
  }
  if (action === 'create_ai') {
    return await createFacetRef(cwd, 'instructions', ctx, true) ?? current;
  }
  if (action === 'edit_editor') {
    return await editFacetWithEditor(cwd, 'instructions', current, ctx) ?? current;
  }
  if (action === 'default') {
    return defaultRef;
  }
  return current;
}

async function selectFacetRefs(
  kind: FacetType,
  cwd: string,
  current: string[],
  lookupConfig: FacetLookupConfig,
  lang: ExecLanguage,
): Promise<string[] | null> {
  const entries = normalizeFacetEntries(kind, cwd, lookupConfig);
  const options: Array<{ label: string; value: string; description?: string }> = entries.map((entry) => ({
    label: sanitizeTerminalText(entry.name),
    value: entry.name,
    description: `${sanitizeTerminalText(execSourceLabel(lang, entry.source))} · ${sanitizeTerminalText(entry.description)}`,
  }));
  const availableValues = new Set(options.map((option) => option.value));

  for (const ref of current) {
    if (availableValues.has(ref)) {
      continue;
    }
    const resolutionContext = {
      projectDir: cwd,
      lang: lookupConfig.language,
      repertoireDir: getRepertoireDir(),
    };
    const isResolvableScopeRef = isScopeRef(ref)
      && resolveFacetPath(ref, kind, resolutionContext) !== undefined;
    const resolvedResource = isResourcePath(ref)
      ? resolveResourceContentWithSource(ref, cwd, kind, ref, resolutionContext)
      : undefined;
    const isResolvableResourcePath = resolvedResource?.sourcePath !== undefined;
    if (isResolvableScopeRef) {
      options.push({
        label: sanitizeTerminalText(ref),
        value: ref,
        description: sanitizeTerminalText(execSourceLabel(lang, 'repertoire')),
      });
      availableValues.add(ref);
      continue;
    }
    if (isResolvableResourcePath) {
      options.push({
        label: sanitizeTerminalText(ref),
        value: ref,
      });
      availableValues.add(ref);
    }
  }

  return await selectMultipleExecOptions<string>(
    lang,
    execLabel(lang, 'facets.multiSelectPrompt', { kind: execFacetKindLabel(lang, kind) }),
    options,
    current,
  );
}

export async function editFacetRefList(
  cwd: string,
  kind: Extract<FacetType, 'knowledge' | 'policies'>,
  current: string[],
  ctx: ExecSessionContext,
): Promise<string[]> {
  const kindLabel = execFacetKindLabel(ctx.lang, kind);
  const action = await selectExecOption<FacetListAction>(ctx.lang, execLabel(ctx.lang, 'facets.listPrompt', { kind: kindLabel }), [
    {
      label: execLabel(ctx.lang, 'facets.toggleExisting'),
      value: 'toggle',
      description: current.map((name) => sanitizeTerminalText(name)).join(', ') || execLabel(ctx.lang, 'common.none'),
    },
    { label: execLabel(ctx.lang, 'facets.createWithEditor'), value: 'create_editor' },
    { label: execLabel(ctx.lang, 'facets.createWithAI'), value: 'create_ai' },
    { label: execLabel(ctx.lang, 'facets.clearAll'), value: 'clear' },
    { label: execLabel(ctx.lang, 'common.back'), value: 'back' },
  ]);
  if (action === 'toggle') {
    const selectedFacetRefs = await selectFacetRefs(kind, cwd, current, ctx.facetLookupConfig, ctx.lang);
    if (selectedFacetRefs === null) {
      return current;
    }
    return selectedFacetRefs;
  }
  if (action === 'create_editor' || action === 'create_ai') {
    const created = await createFacetRef(cwd, kind, ctx, action === 'create_ai');
    return created === null || current.includes(created) ? current : [...current, created];
  }
  if (action === 'clear') {
    return [];
  }
  return current;
}
