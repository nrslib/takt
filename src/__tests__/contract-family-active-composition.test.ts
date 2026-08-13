import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getAllParallelSubSteps,
  type WorkflowConfig,
  type WorkflowStep,
} from '../core/models/types.js';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';
import { loadCompanionDefinition } from '../infra/config/loaders/companionDefinitionLoader.js';
import { resolveRefToContent } from '../infra/config/loaders/resource-resolver.js';
import { resolveWorkflowCallTarget } from '../infra/config/loaders/workflowCallResolver.js';
import {
  getBuiltinWorkflow,
  listBuiltinWorkflowNames,
} from '../infra/config/loaders/workflowResolver.js';
import { getBuiltinCompanionsDir } from '../infra/config/paths.js';
import { getLanguageResourcesDir } from '../infra/resources/index.js';
import {
  CONTRACT_FAMILY_ROLE_MANIFEST,
  outsideContractFamilyReason,
  type ContractFamilyToolClass,
} from './fixtures/contract-family-active-manifest.js';
import {
  callerPathExpectation,
  COMPANION_DECLARATION_MANIFEST,
  DECLARED_INSTRUCTION_MANIFEST,
} from './fixtures/contract-family-declared-instruction-manifest.js';

const LANGUAGES = ['en', 'ja'] as const;
const ROLE_PATTERN = /\*\*Contract family role: `([^`]+)`\*\*/gu;
const OLD_ALIASES = [
  'review-family-authority-boundary',
  'review-family-completion',
  'fix-family-completion',
  'initial-review-scope',
  'follow-up-review-scope',
  'final-gate-new-finding-scope',
] as const;

interface ManifestEntry {
  path: string;
  classification: 'target' | 'outside';
  role?: string;
  declaredInstruction?: string;
  wrapper?: string;
  outsideReason?: string;
  tags: string[];
  phase: 'plan' | 'edit' | 'review' | 'companion' | 'outside';
  edit: boolean;
  requiredPermissionMode: string;
  toolClass: ContractFamilyToolClass;
  executionKind: 'agent' | 'team-leader' | 'companion';
}

function rolesIn(instruction: string | undefined): string[] {
  if (instruction === undefined) return [];
  return [...instruction.matchAll(ROLE_PATTERN)].map((match) => match[1]!);
}

function coreCount(instruction: string): number {
  return instruction.match(/\*\*Contract family core\*\*/gu)?.length ?? 0;
}

function expandedWrapper(wrapper: string, lang: 'en' | 'ja'): string {
  const partialsDir = join(getLanguageResourcesDir(lang), 'facets', 'partials', 'instructions');
  const wrapperContent = readFileSync(join(partialsDir, `${wrapper}.md`), 'utf8').trim();
  const coreContent = readFileSync(join(partialsDir, 'contract-family-core.md'), 'utf8').trim();
  return wrapperContent.replace('{{include:instructions/contract-family-core}}', coreContent);
}

function normalizePromptWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function assertDeclaredInstructionContent(
  declaredInstruction: string,
  actualInstruction: string,
  lang: 'en' | 'ja',
  path: string,
): { role: string; wrapper: string } {
  const declaration = DECLARED_INSTRUCTION_MANIFEST[declaredInstruction];
  expect(declaration, `Missing declaration manifest entry: ${path} -> ${declaredInstruction}`).toBeDefined();
  expect(rolesIn(actualInstruction), path).toEqual([declaration!.role]);
  expect(coreCount(actualInstruction), path).toBe(1);
  expect(normalizePromptWhitespace(actualInstruction), `${path} -> ${declaration!.wrapper}`)
    .toContain(normalizePromptWhitespace(expandedWrapper(declaration!.wrapper, lang)));
  return declaration!;
}

function assertCallerInstruction(
  path: string,
  declaredInstruction: string | undefined,
  actualInstruction: string,
  lang: 'en' | 'ja',
): { role: string; wrapper: string } {
  const pathExpectation = callerPathExpectation(path);
  expect(pathExpectation, `Missing independent caller-path expectation: ${path}`).toBeDefined();
  const declaration = declaredInstruction === undefined
    ? undefined
    : DECLARED_INSTRUCTION_MANIFEST[declaredInstruction];
  expect(declaration, `Missing declaration manifest entry: ${path} -> ${String(declaredInstruction)}`).toBeDefined();
  expect(declaration, `Caller role mismatch: ${path} -> ${String(declaredInstruction)}`).toEqual(pathExpectation);
  return assertDeclaredInstructionContent(declaredInstruction!, actualInstruction, lang, path);
}

function assertCompanionDeclaration(name: string, declaredInstruction: string): void {
  const expected = COMPANION_DECLARATION_MANIFEST[
    name as keyof typeof COMPANION_DECLARATION_MANIFEST
  ];
  expect(expected, `Unclassified companion definition: ${name}`).toBeDefined();
  expect(declaredInstruction, `companion:${name}`).toBe(expected);
}

function toolClass(step: WorkflowStep): ContractFamilyToolClass {
  const options = JSON.stringify(step.capabilityProviderOptions ?? null);
  return options.includes('edit') || options.includes('write') ? 'edit-tools' : 'read-tools';
}

function phaseFromTags(tags: readonly string[]): 'plan' | 'edit' | 'review' {
  if (tags.includes('coding')) return 'edit';
  if (tags.includes('plan')) return 'plan';
  if (tags.includes('review')) return 'review';
  throw new Error(`Active contract-family caller lacks a phase tag: ${tags.join(', ')}`);
}

function classifyAgentStep(step: WorkflowStep, path: string, lang: 'en' | 'ja'): ManifestEntry {
  const outsideReason = outsideContractFamilyReason(path);
  if (outsideReason !== undefined) {
    expect(rolesIn(step.instruction), path).toHaveLength(0);
    expect(coreCount(step.instruction), path).toBe(0);
    return {
      path,
      classification: 'outside',
      outsideReason,
      tags: [...(step.tags ?? [])].sort(),
      phase: 'outside',
      edit: step.edit === true,
      requiredPermissionMode: step.requiredPermissionMode ?? 'unspecified',
      toolClass: toolClass(step),
      executionKind: step.teamLeader === undefined ? 'agent' : 'team-leader',
    };
  }
  const declaredInstruction = step.instructionRef;
  const pathExpectation = callerPathExpectation(path);
  const declaration = declaredInstruction === undefined
    ? undefined
    : DECLARED_INSTRUCTION_MANIFEST[declaredInstruction];
  if (pathExpectation !== undefined) {
    const callerDeclaration = assertCallerInstruction(path, declaredInstruction, step.instruction, lang);
    return {
      path,
      classification: 'target',
      role: callerDeclaration.role,
      wrapper: callerDeclaration.wrapper,
      declaredInstruction,
      tags: [...(step.tags ?? [])].sort(),
      phase: phaseFromTags(step.tags ?? []),
      edit: step.edit === true,
      requiredPermissionMode: step.requiredPermissionMode ?? 'unspecified',
      toolClass: toolClass(step),
      executionKind: step.teamLeader === undefined ? 'agent' : 'team-leader',
    };
  }
  expect(declaration, `Target declaration lacks an independent caller-path expectation: ${path}`).toBeUndefined();
  expect(outsideReason, `Unclassified active caller: ${path}`).toBeDefined();
  expect(rolesIn(step.instruction), path).toHaveLength(0);
  expect(coreCount(step.instruction), path).toBe(0);
  return {
    path,
    classification: 'outside',
    outsideReason,
    tags: [...(step.tags ?? [])].sort(),
    phase: 'outside',
    edit: step.edit === true,
    requiredPermissionMode: step.requiredPermissionMode ?? 'unspecified',
    toolClass: toolClass(step),
    executionKind: step.teamLeader === undefined ? 'agent' : 'team-leader',
  };
}

function collectResolvedCallers(
  workflow: WorkflowConfig,
  projectDir: string,
  lang: 'en' | 'ja',
  rootName: string,
  prefix: string,
  depth: number,
): ManifestEntry[] {
  if (depth > 16) throw new Error(`Unexpected workflow-call depth from ${rootName}`);
  const entries: ManifestEntry[] = [];
  const visit = (step: WorkflowStep, path: string): void => {
    if (typeof step.persona === 'string') entries.push(classifyAgentStep(step, path, lang));
    for (const [index, substep] of getAllParallelSubSteps(step.parallel ?? []).entries()) {
      visit(substep, `${path}/parallel[${index}]:${substep.name}`);
    }
    if (step.kind !== 'workflow_call') return;
    const target = resolveWorkflowCallTarget(workflow, step, projectDir);
    if (target === null) throw new Error(`Unresolved workflow call at ${path}`);
    entries.push(...collectResolvedCallers(target, projectDir, lang, rootName, `${path}/call:${target.name}/`, depth + 1));
  };
  for (const [index, step] of workflow.steps.entries()) {
    visit(step, `${rootName}/${prefix}steps[${index}]:${step.name}`);
  }
  return entries;
}

function workflowManifest(projectDir: string, lang: 'en' | 'ja'): ManifestEntry[] {
  return listBuiltinWorkflowNames(projectDir, { includeDisabled: true })
    .flatMap((name) => {
      const workflow = getBuiltinWorkflow(name, projectDir);
      if (workflow === null) throw new Error(`Unable to load builtin workflow ${name}`);
      return collectResolvedCallers(workflow, projectDir, lang, name, '', 0);
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function companionManifest(projectDir: string, lang: 'en' | 'ja'): ManifestEntry[] {
  const directory = getBuiltinCompanionsDir(lang);
  return readdirSync(directory)
    .filter((name) => name.endsWith('.yaml'))
    .map((fileName) => {
      const name = basename(fileName, '.yaml');
      const definition = loadCompanionDefinition(name, {
        candidateDirs: [directory],
        language: lang,
        facetContext: { projectDir, lang },
      });
      const declaredInstruction = COMPANION_DECLARATION_MANIFEST[
        name as keyof typeof COMPANION_DECLARATION_MANIFEST
      ];
      assertCompanionDeclaration(name, definition.instructionRef);
      const declaration = assertDeclaredInstructionContent(
        declaredInstruction!, definition.instruction, lang, `companion:${name}`,
      );
      return {
        path: `companion:${name}`,
        classification: 'target' as const,
        role: declaration.role,
        wrapper: declaration.wrapper,
        declaredInstruction,
        tags: ['companion'],
        phase: 'companion',
        edit: false,
        requiredPermissionMode: 'tool-less',
        toolClass: 'tool-less' as const,
        executionKind: 'companion' as const,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function assertRoleContract(entry: ManifestEntry): void {
  if (entry.classification === 'outside') {
    expect(entry.outsideReason, entry.path).toBeTruthy();
    return;
  }
  const expectation = CONTRACT_FAMILY_ROLE_MANIFEST[
    entry.role as keyof typeof CONTRACT_FAMILY_ROLE_MANIFEST
  ];
  expect(expectation, `Unknown role at ${entry.path}`).toBeDefined();
  expect(entry.tags, entry.path).toContain(expectation.requiredTag);
  expect(entry.phase, entry.path).toBe(expectation.phase);
  expect(entry.edit, entry.path).toBe(expectation.edit);
  expect(expectation.requiredPermissionModes, entry.path).toContain(entry.requiredPermissionMode);
  expect(expectation.toolClasses, entry.path).toContain(entry.toolClass);
}

describe('contract-family active composition', () => {
  let rootDir: string;
  let projectDirs: Record<(typeof LANGUAGES)[number], string>;

  beforeAll(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'takt-contract-family-manifest-'));
    projectDirs = Object.fromEntries(LANGUAGES.map((lang) => {
      const projectDir = join(rootDir, lang);
      mkdirSync(join(projectDir, '.takt'), { recursive: true });
      writeFileSync(join(projectDir, '.takt', 'config.yaml'), `language: ${lang}\n`);
      return [lang, projectDir];
    })) as Record<(typeof LANGUAGES)[number], string>;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterAll(() => {
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('classifies every actual resolved builtin caller from an independent manifest with locale parity', () => {
    const manifests = Object.fromEntries(LANGUAGES.map((lang) => [lang, workflowManifest(projectDirs[lang], lang)])) as Record<'en' | 'ja', ManifestEntry[]>;
    expect(manifests.ja).toEqual(manifests.en);
    expect(manifests.ja.length).toBeGreaterThan(0);
    for (const entry of manifests.ja) assertRoleContract(entry);
    expect(manifests.ja.some(({ executionKind }) => executionKind === 'team-leader')).toBe(true);
    expect(manifests.ja.some(({ path }) => path.includes('/parallel['))).toBe(true);
    expect(manifests.ja.some(({ path }) => path.includes('/call:'))).toBe(true);
  });

  it('classifies every real-loader companion without hard-coded role projection', () => {
    const ja = companionManifest(projectDirs.ja, 'ja');
    const en = companionManifest(projectDirs.en, 'en');
    expect(ja).toEqual(en);
    for (const entry of ja) assertRoleContract(entry);
  });

  it.each(LANGUAGES)('keeps a one-way wrapper-to-core DAG with no semantic aliases in %s', (lang) => {
    const partialsDir = join(getLanguageResourcesDir(lang), 'facets', 'partials', 'instructions');
    const wrapperFiles = readdirSync(partialsDir).filter((name) => name.startsWith('contract-family-') && name.endsWith('.md'));
    const coreName = 'contract-family-core.md';
    expect(wrapperFiles).toContain(coreName);
    for (const fileName of wrapperFiles) {
      const content = readFileSync(join(partialsDir, fileName), 'utf8');
      const includes = [...content.matchAll(/\{\{include:instructions\/(contract-family-[^}]+)\}\}/gu)].map((match) => match[1]!);
      expect(includes, fileName).toEqual(fileName === coreName ? [] : ['contract-family-core']);
    }
    for (const alias of OLD_ALIASES) expect(wrapperFiles, alias).not.toContain(`${alias}.md`);
  });

  it.each(LANGUAGES)('expands every declared role instruction to exactly one wrapper and neutral core in %s', (lang) => {
    const projectDir = projectDirs[lang];
    for (const name of Object.keys(DECLARED_INSTRUCTION_MANIFEST)) {
      const content = resolveRefToContent(name, undefined, projectDir, 'instructions', { projectDir, lang });
      expect(content, name).toBeDefined();
      assertDeclaredInstructionContent(name, content!, lang, name);
      for (const alias of OLD_ALIASES) expect(content, `${name}:${alias}`).not.toContain(alias);
    }
  });

  it.each(LANGUAGES)('rejects role-wrapper swaps independently of actual prompt markers in %s', (lang) => {
    const projectDir = projectDirs[lang];
    const swaps = [
      ['architecture-review', 'follow-up-architecture-review'],
      ['follow-up-architecture-review', 'architecture-review'],
      ['companion-watch-review', 'companion-moderate-review'],
      ['companion-moderate-review', 'companion-watch-review'],
      ['fix', 'apply-fix-verification'],
      ['apply-fix-verification', 'verify-fix'],
      ['verify-fix', 'fix'],
      ['plan', 'review-merge-readiness'],
      ['review-merge-readiness', 'plan'],
    ] as const;
    for (const [declaredInstruction, swappedInstruction] of swaps) {
      const swappedContent = resolveRefToContent(
        swappedInstruction, undefined, projectDir, 'instructions', { projectDir, lang },
      );
      expect(swappedContent, swappedInstruction).toBeDefined();
      expect(() => assertDeclaredInstructionContent(
        declaredInstruction,
        swappedContent!,
        lang,
        `${declaredInstruction}->${swappedInstruction}`,
      )).toThrow();
    }
  });

  it.each(LANGUAGES)('rejects caller declaration role swaps independently of prompt contents in %s', (lang) => {
    const projectDir = projectDirs[lang];
    const swaps = [
      ['fixture/call:peer-review/steps[0]:initial-reviewers/parallel[0]:review', 'follow-up-architecture-review'],
      ['fixture/call:peer-review/steps[1]:reviewers/parallel[0]:review', 'architecture-review'],
      ['fixture/steps[0]:fix', 'apply-fix-verification'],
      ['fixture/steps[0]:fix-retry', 'verify-fix'],
      ['fixture/steps[0]:fix-verifier', 'fix'],
      ['fixture/steps[0]:plan', 'review-merge-readiness'],
      ['fixture/steps[0]:final-gate', 'plan'],
    ] as const;
    for (const [path, swappedInstruction] of swaps) {
      const content = resolveRefToContent(
        swappedInstruction, undefined, projectDir, 'instructions', { projectDir, lang },
      );
      expect(content, swappedInstruction).toBeDefined();
      expect(() => assertCallerInstruction(path, swappedInstruction, content!, lang)).toThrow();
    }
    expect(() => assertCompanionDeclaration(
      'ai-antipattern-review-companion',
      'companion-moderate-review',
    )).toThrow();
    expect(() => assertCompanionDeclaration(
      'review-companion-moderator',
      'companion-watch-review',
    )).toThrow();
  });
});
