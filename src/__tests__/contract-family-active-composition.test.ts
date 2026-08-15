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
const EXISTING_FAMILY_LOOKUP_WRAPPERS = new Set([
  'contract-family-initial-review.md',
  'contract-family-follow-up-review.md',
  'contract-family-review-by-mode.md',
  'contract-family-final-preservation.md',
]);

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
  familyRecordingContracts?: Array<{ name: string; formatRef?: string }>;
}

const FAMILY_RECORDING_SHAPES = {
  ja: [
    {
      heading: '## 問題系列の完了走査',
      sectionMarkers: ['family_tag / 変更契約', '担当箇所', '観測可能な不変条件', '同じ原因で変更される理由', '追加した経路'],
      formatMarkers: ['| # | finding_id | family_tag |'],
    },
    {
      heading: '## 修正対象 family',
      sectionMarkers: ['| family |', '担当箇所', '観測可能な不変条件', '同じ原因で変更される理由', '追加した経路'],
      formatMarkers: [],
    },
  ],
  en: [
    {
      heading: '## Problem-Family Completion Sweep',
      sectionMarkers: ['family_tag / changed contract', 'Responsible source', 'Observable invariant', 'Reason to change from the same cause', 'Added path'],
      formatMarkers: ['| # | finding_id | family_tag |'],
    },
    {
      heading: '## Actionable Families',
      sectionMarkers: ['| family |', 'Responsible source', 'Observable invariant', 'Reason to change from the same cause', 'Added path'],
      formatMarkers: [],
    },
  ],
} as const;

function markdownSection(content: string, heading: string): string | undefined {
  const start = content.indexOf(heading);
  if (start < 0) return undefined;
  const end = content.indexOf('\n## ', start + heading.length);
  return content.slice(start, end < 0 ? undefined : end);
}

function assertExistingFamilyRecordingContracts(
  step: WorkflowStep,
  path: string,
  lang: 'en' | 'ja',
): Array<{ name: string; formatRef?: string }> {
  const marker = lang === 'ja' ? '**既出 family の照合:**' : '**Existing-family lookup:**';
  expect(step.instruction, path).toContain(marker);
  const writableContracts = (step.outputContracts ?? [])
    .filter(({ useJudge }) => useJudge !== false);
  for (const { format, formatRef } of writableContracts) {
    if (formatRef !== 'merge-readiness-supervision') continue;
    const heading = lang === 'ja' ? '## 前段 finding の扱い' : '## Prior Finding Dispositions';
    const markers = lang === 'ja'
      ? ['対象 family', '同じ原因で変更される理由', '合流根拠']
      : ['Target family', 'Reason to change from the same cause', 'Rationale'];
    const section = markdownSection(format, heading);
    expect(section, `${path}:${formatRef}`).toBeDefined();
    for (const value of markers) expect(section, `${path}:${formatRef}:${value}`).toContain(value);
  }
  const matchingContracts = writableContracts
    .filter(({ format }) => FAMILY_RECORDING_SHAPES[lang]
      .some(({ heading, sectionMarkers, formatMarkers }) => {
        const section = markdownSection(format, heading);
        return section !== undefined
          && sectionMarkers.every((value) => section.includes(value))
          && formatMarkers.every((value) => format.includes(value));
      }))
    .map(({ name, formatRef }) => ({ name, ...(formatRef === undefined ? {} : { formatRef }) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  expect(matchingContracts.length, `${path} must persist existing-family matches in a primary output contract`)
    .toBeGreaterThan(0);
  return matchingContracts;
}

function rolesIn(instruction: string | undefined): string[] {
  if (instruction === undefined) return [];
  return [...instruction.matchAll(ROLE_PATTERN)].map((match) => match[1]!);
}

function coreCount(instruction: string): number {
  return instruction.match(/\*\*Contract family core\*\*/gu)?.length ?? 0;
}

function expandedInstructionPartial(
  name: string,
  lang: 'en' | 'ja',
  ancestors: ReadonlySet<string> = new Set(),
): string {
  if (ancestors.has(name)) throw new Error(`Circular instruction partial include: ${name}`);
  const partialsDir = join(getLanguageResourcesDir(lang), 'facets', 'partials', 'instructions');
  const content = readFileSync(join(partialsDir, `${name}.md`), 'utf8').trim();
  const nextAncestors = new Set(ancestors).add(name);
  return content.replace(
    /\{\{include:instructions\/([^}]+)\}\}/gu,
    (_include: string, childName: string) => expandedInstructionPartial(childName, lang, nextAncestors),
  );
}

function expandedWrapper(wrapper: string, lang: 'en' | 'ja'): string {
  return expandedInstructionPartial(wrapper, lang);
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
    const familyRecordingContracts = EXISTING_FAMILY_LOOKUP_WRAPPERS.has(`${callerDeclaration.wrapper}.md`)
      ? assertExistingFamilyRecordingContracts(step, path, lang)
      : undefined;
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
      ...(familyRecordingContracts === undefined ? {} : { familyRecordingContracts }),
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

  it('resolves every existing-family lookup caller through a writable output contract in both locales', () => {
    const manifests = Object.fromEntries(LANGUAGES.map((lang) => [lang, workflowManifest(projectDirs[lang], lang)])) as Record<'en' | 'ja', ManifestEntry[]>;
    expect(manifests.ja).toEqual(manifests.en);
    const lookupEntries = manifests.ja.filter(({ wrapper }) => (
      wrapper !== undefined && EXISTING_FAMILY_LOOKUP_WRAPPERS.has(`${wrapper}.md`)
    ));
    expect(lookupEntries.length).toBeGreaterThan(0);
    for (const entry of lookupEntries) {
      expect(entry.familyRecordingContracts, entry.path).toBeDefined();
      expect(entry.familyRecordingContracts!.length, entry.path).toBeGreaterThan(0);
    }
    const resolvedFormats = new Set(lookupEntries.flatMap(({ familyRecordingContracts }) => (
      familyRecordingContracts?.map(({ formatRef }) => formatRef) ?? []
    )));
    expect(resolvedFormats).toContain('merge-readiness-review');
    expect(resolvedFormats).toContain('supervisor-validation');
    expect(resolvedFormats).toContain('merge-readiness-supervision');
  });

  it.each(LANGUAGES)('persists every family identity field in adjudication output for %s', (lang) => {
    const content = readFileSync(join(
      getLanguageResourcesDir(lang),
      'facets',
      'output-contracts',
      'review-decision.md',
    ), 'utf8');
    const heading = lang === 'ja' ? '## 修正対象 family' : '## Actionable Families';
    const markers = lang === 'ja'
      ? ['担当箇所', '観測可能な不変条件', '同じ原因で変更される理由']
      : ['Responsible source', 'Observable invariant', 'Reason to change from the same cause'];
    const section = markdownSection(content, heading);
    expect(section, heading).toBeDefined();
    for (const value of markers) expect(section, `${heading}:${value}`).toContain(value);
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
      expect(content.includes('{{include:instructions/existing-family-lookup}}'), fileName)
        .toBe(EXISTING_FAMILY_LOOKUP_WRAPPERS.has(fileName));
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
