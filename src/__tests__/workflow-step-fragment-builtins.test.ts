import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import {
  getBuiltinLanguageStepsDir,
  getBuiltinStepsDir,
  getBuiltinWorkflowsDir,
} from '../infra/config/paths.js';
import { buildStepFragmentLookupDirs } from '../infra/config/loaders/stepFragmentLookupDirectories.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';

type RawStep = Record<string, unknown>;
interface RawLoopMonitor {
  cycle: string[];
  threshold: number;
  judge: unknown;
}
type RawWorkflow = { loop_monitors?: RawLoopMonitor[]; steps: RawStep[] };
type Language = 'en' | 'ja';

const LANGUAGES: Language[] = ['en', 'ja'];
const REVIEWER_WORKFLOWS = ['takt-default-high', 'takt-default-team-high', 'review-fix-takt-default-high'];
const REPLAN_WORKFLOWS = [...REVIEWER_WORKFLOWS, 'takt-default-localllm'];
const GATHER_WORKFLOWS = ['review-fix-takt-default', 'review-fix-takt-default-high'];
const FIX_WORKFLOWS = ['takt-default-high', 'review-fix-takt-default-high'];

function readBuiltinWorkflow(lang: Language, name: string): RawWorkflow {
  return parseYaml(readFileSync(join(getBuiltinWorkflowsDir(lang), name + '.yaml'), 'utf-8')) as RawWorkflow;
}

function getStep(raw: RawWorkflow, name: string): RawStep {
  const step = raw.steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error('Builtin workflow does not define step "' + name + '"');
  return step;
}

function expectFragmentReference(step: RawStep, name: string): string {
  expect(step.name).toBe(name);
  expect(typeof step.uses).toBe('string');
  return step.uses as string;
}

describe('builtin workflow step fragment migration', () => {
  let projectDir: string;
  let globalConfigDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-step-fragment-builtins-project-'));
    globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-step-fragment-builtins-global-'));
    previousConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = globalConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalConfigDir, { recursive: true, force: true });
    if (previousConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = previousConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
  });

  it.each(LANGUAGES)('looks up %s language fragments before the shared builtin directory', (lang) => {
    const dirs = buildStepFragmentLookupDirs({ lang });
    const languageStepsDir = getBuiltinLanguageStepsDir(lang);

    expect(dirs).toContain(languageStepsDir);
    expect(dirs.indexOf(languageStepsDir)).toBeLessThan(dirs.indexOf(getBuiltinStepsDir()));
  });

  it.each(LANGUAGES)('moves the %s reviewers steps to one language-specific fragment', (lang) => {
    const refs = REVIEWER_WORKFLOWS.map((workflow) =>
      expectFragmentReference(getStep(readBuiltinWorkflow(lang, workflow), 'reviewers'), 'reviewers'));

    expect(new Set(refs).size).toBe(1);
    expect(existsSync(join(getBuiltinLanguageStepsDir(lang), `${refs[0]}.yaml`))).toBe(true);
  });

  it.each(LANGUAGES)('moves the %s gather steps to one language-specific fragment', (lang) => {
    const refs = GATHER_WORKFLOWS.map((workflow) =>
      expectFragmentReference(getStep(readBuiltinWorkflow(lang, workflow), 'gather'), 'gather'));

    expect(new Set(refs).size).toBe(1);
    expect(existsSync(join(getBuiltinLanguageStepsDir(lang), `${refs[0]}.yaml`))).toBe(true);
  });

  it.each(LANGUAGES)('moves the %s fix steps to one language-specific fragment', (lang) => {
    const refs = FIX_WORKFLOWS.map((workflow) =>
      expectFragmentReference(getStep(readBuiltinWorkflow(lang, workflow), 'fix'), 'fix'));

    expect(new Set(refs).size).toBe(1);
    expect(existsSync(join(getBuiltinLanguageStepsDir(lang), `${refs[0]}.yaml`))).toBe(true);
  });

  it.each(LANGUAGES)('moves the %s replan steps to one language-specific three-state fragment', (lang) => {
    const refs = REPLAN_WORKFLOWS.map((workflow) =>
      expectFragmentReference(getStep(readBuiltinWorkflow(lang, workflow), 'replan'), 'replan'));

    expect(new Set(refs)).toEqual(new Set(['replan']));
    expect(existsSync(join(getBuiltinLanguageStepsDir(lang), 'replan.yaml'))).toBe(true);

    for (const name of REPLAN_WORKFLOWS) {
      const workflow = loadWorkflowFromFile(
        join(getBuiltinWorkflowsDir(lang), name + '.yaml'),
        projectDir,
      );
      const replan = workflow.steps.find((step) => step.name === 'replan');

      expect(replan?.rules.map((rule) => rule.next)).toEqual(['implement', 'reviewers', 'ABORT']);
      expect(replan?.rules.map((rule) => rule.next)).not.toContain('COMPLETE');
    }
  });

  it.each(LANGUAGES)('covers every direct %s replan-review cycle with the matching finite-stop monitor', (lang) => {
    const companionCycles = [
      ['replan', 'reviewers'],
      ['replan', 'reviewers', 'final-gate'],
      ['replan', 'reviewers', 'fix'],
    ];

    for (const name of REVIEWER_WORKFLOWS) {
      const monitors = readBuiltinWorkflow(lang, name).loop_monitors ?? [];
      for (const cycle of companionCycles) {
        const sourceCycle = [cycle[0]!, 'implement', ...cycle.slice(1)];
        const source = monitors.find((monitor) => monitor.cycle.join('\0') === sourceCycle.join('\0'));
        const companion = monitors.find((monitor) => monitor.cycle.join('\0') === cycle.join('\0'));

        expect(source).toBeDefined();
        expect(companion).toMatchObject({
          threshold: source?.threshold,
          judge: source?.judge,
        });
      }
    }
  });

  it('moves both supervise steps to the same shared fragment', () => {
    const refs = LANGUAGES.map((lang) =>
      expectFragmentReference(getStep(readBuiltinWorkflow(lang, 'merge-readiness-finding-contract-final-gate'), 'supervise'), 'supervise'));

    expect(new Set(refs).size).toBe(1);
    expect(existsSync(join(getBuiltinStepsDir(), `${refs[0]}.yaml`))).toBe(true);
  });

  it.each(LANGUAGES)('loads migrated %s builtin workflows through the fragment resolver', (lang) => {
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), 'language: ' + lang + '\n', 'utf-8');
    invalidateAllResolvedConfigCache();

    const workflows = new Set([
      ...REVIEWER_WORKFLOWS,
      ...REPLAN_WORKFLOWS,
      ...GATHER_WORKFLOWS,
      ...FIX_WORKFLOWS,
      'merge-readiness-finding-contract-final-gate',
    ]);
    for (const name of workflows) {
      expect(() => loadWorkflowFromFile(join(getBuiltinWorkflowsDir(lang), name + '.yaml'), projectDir)).not.toThrow();
    }
  });

  it.each(LANGUAGES)(
    'expands the %s high workflows with terminal provisional routing and typed final-gate authority',
    (lang) => {
      for (const name of REVIEWER_WORKFLOWS) {
        const workflow = loadWorkflowFromFile(
          join(getBuiltinWorkflowsDir(lang), name + '.yaml'),
          projectDir,
        );
        const reviewers = workflow.steps.find((step) => step.name === 'reviewers');
        const finalGate = workflow.steps.find((step) => step.name === 'final-gate');
        const terminalRouteIndex = reviewers?.rules.findIndex((rule) => (
          rule.condition.kind === 'when'
          && rule.condition.expression
            === 'findings.provisional.dismissEligible.count > 0 && findings.conflicts.count == 0'
          && rule.next === 'final-gate'
        )) ?? -1;
        const activeConflictIndex = reviewers?.rules.findIndex((rule) => (
          rule.condition.kind === 'when'
          && rule.condition.expression === 'findings.conflicts.count > 0'
        )) ?? -1;
        const fixpointIndex = reviewers?.rules.findIndex((rule) => (
          rule.condition.kind === 'when'
          && rule.condition.expression
            === 'findings.provisional.fixpoint == true && findings.conflicts.count == 0'
        )) ?? -1;

        expect(activeConflictIndex).toBeGreaterThanOrEqual(0);
        expect(terminalRouteIndex).toBeGreaterThan(activeConflictIndex);
        expect(fixpointIndex).toBeGreaterThan(terminalRouteIndex);
        expect(finalGate).toMatchObject({
          kind: 'workflow_call',
          findingContractAuthority: 'terminal_adjudication',
        });
      }
    },
  );

});
