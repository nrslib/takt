import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getGlobalFacetDir, getProjectFacetDir } from '../../infra/config/paths.js';
import { getFacetDirs, scanFacets, type FacetLookupConfig, type FacetType } from '../catalog/catalogFacets.js';
import { readInteractiveInput } from '../interactive/interactiveInput.js';
import { selectOption } from '../../shared/prompt/index.js';
import { info } from '../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../shared/utils/index.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import { askExecAssistant, type ExecSessionContext } from './assistantSession.js';
import { promptText } from './promptUtils.js';
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

async function selectExistingFacet(kind: FacetType, cwd: string, lookupConfig: FacetLookupConfig): Promise<string | null> {
  const entries = normalizeFacetEntries(kind, cwd, lookupConfig);
  const selected = await selectOption<string>(`Select ${kind} facet`, entries.map((entry) => ({
    label: sanitizeTerminalText(entry.name),
    value: entry.name,
    description: `${sanitizeTerminalText(entry.source)} · ${sanitizeTerminalText(entry.description)}`,
  })));
  return selected;
}

async function selectFacetScope(message: string): Promise<WritableFacetScope | null> {
  return await selectOption<WritableFacetScope>(message, [
    { label: 'Project', value: 'project', description: '.takt/facets' },
    { label: 'Global', value: 'global', description: '~/.takt/facets' },
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

async function confirmGeneratedFacet(kind: FacetType, name: string, content: string): Promise<boolean> {
  info(`Generated ${kind} facet "${sanitizeTerminalText(name)}":`);
  info(sanitizeTerminalText(content));
  const approved = await selectOption<'save' | 'discard'>('Save generated facet?', [
    { label: 'Save', value: 'save' },
    { label: 'Discard', value: 'discard' },
  ]);
  return approved === 'save';
}

async function promptFacetConsultation(kind: FacetType, name: string, ctx: ExecSessionContext): Promise<string | null> {
  const input = await readInteractiveInput(
    `Describe the ${kind} facet changes for ${sanitizeTerminalText(name)}: `,
    ctx.lang,
    { enableSetupCommand: false },
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
  if (!await confirmGeneratedFacet(kind, name, generated.content)) {
    return null;
  }
  return writeFacetFile(cwd, kind, scope, name, generated.content);
}

async function createFacetRef(cwd: string, kind: FacetType, ctx: ExecSessionContext, useAI: boolean): Promise<string | null> {
  const scope = await selectFacetScope('Facet save scope');
  if (scope === null) {
    return null;
  }
  const name = await promptText('Facet name', 'custom', ctx.lang);
  const ref = useAI
    ? await createFacetWithAI(cwd, kind, scope, name, ctx)
    : writeFacetFile(cwd, kind, scope, name, runEditor(`# ${name}\n\n`, name));
  if (ref !== null) {
    info(`Created ${sanitizeTerminalText(scope)} ${kind} facet: ${sanitizeTerminalText(ref)}`);
  }
  return ref;
}

async function editFacetWithAI(
  cwd: string,
  kind: FacetType,
  current: string,
  ctx: ExecSessionContext,
): Promise<string | null> {
  const scope = await selectFacetScope('Edited facet save scope');
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
  if (!await confirmGeneratedFacet(kind, current, generated.content)) {
    return null;
  }
  return overwriteFacetFile(cwd, kind, scope, current, generated.content);
}

async function editFacetWithEditor(
  cwd: string,
  kind: FacetType,
  current: string,
  lookupConfig: FacetLookupConfig,
): Promise<string | null> {
  const scope = await selectFacetScope('Edited facet save scope');
  if (scope === null) {
    return null;
  }
  const edited = runEditor(readEffectiveFacetContent(cwd, kind, current, lookupConfig), current);
  return overwriteFacetFile(cwd, kind, scope, current, edited);
}

export async function editInstructionFacetRef(
  cwd: string,
  current: string,
  defaultRef: string,
  ctx: ExecSessionContext,
): Promise<string> {
  const action = await selectOption<InstructionFacetAction>('Instruction facet', [
    { label: `Select existing (${sanitizeTerminalText(current)})`, value: 'select' },
    { label: 'Edit with AI', value: 'ai_edit' },
    { label: 'Create with AI', value: 'create_ai' },
    { label: 'Open in editor', value: 'edit_editor' },
    { label: `Restore default (${sanitizeTerminalText(defaultRef)})`, value: 'default' },
    { label: 'Back', value: 'back' },
  ]);
  if (action === 'select') {
    return await selectExistingFacet('instructions', cwd, ctx.facetLookupConfig) ?? current;
  }
  if (action === 'ai_edit') {
    return await editFacetWithAI(cwd, 'instructions', current, ctx) ?? current;
  }
  if (action === 'create_ai') {
    return await createFacetRef(cwd, 'instructions', ctx, true) ?? current;
  }
  if (action === 'edit_editor') {
    return await editFacetWithEditor(cwd, 'instructions', current, ctx.facetLookupConfig) ?? current;
  }
  if (action === 'default') {
    return defaultRef;
  }
  return current;
}

async function selectFacetToToggle(
  kind: FacetType,
  cwd: string,
  current: string[],
  lookupConfig: FacetLookupConfig,
): Promise<string | null> {
  const entries = normalizeFacetEntries(kind, cwd, lookupConfig);
  return await selectOption<string>(`Toggle ${kind} facet`, entries.map((entry) => ({
    label: `${current.includes(entry.name) ? '[x]' : '[ ]'} ${sanitizeTerminalText(entry.name)}`,
    value: entry.name,
    description: `${sanitizeTerminalText(entry.source)} · ${sanitizeTerminalText(entry.description)}`,
  })));
}

export async function editFacetRefList(
  cwd: string,
  kind: Extract<FacetType, 'knowledge' | 'policies'>,
  current: string[],
  ctx: ExecSessionContext,
): Promise<string[]> {
  const action = await selectOption<FacetListAction>(`${kind} facets`, [
    { label: 'Toggle existing', value: 'toggle', description: current.map((name) => sanitizeTerminalText(name)).join(', ') || 'none' },
    { label: 'Create with editor', value: 'create_editor' },
    { label: 'Create with AI', value: 'create_ai' },
    { label: 'Clear all', value: 'clear' },
    { label: 'Back', value: 'back' },
  ]);
  if (action === 'toggle') {
    const selected = await selectFacetToToggle(kind, cwd, current, ctx.facetLookupConfig);
    if (selected === null) {
      return current;
    }
    return current.includes(selected)
      ? current.filter((name) => name !== selected)
      : [...current, selected];
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
