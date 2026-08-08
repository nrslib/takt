import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { resolveCapabilitySets } from '../infra/config/loaders/capabilitySetResolver.js';
import { isDynamicParallelSubSteps } from '../core/models/index.js';
import type { AgentWorkflowStep, WorkflowConfig, WorkflowStep } from '../core/models/index.js';
import type { StepProviderOptions } from '../core/models/workflow-types.js';

/**
 * ビルトインの能力宣言は capability プリセット参照に一本化されている。YAML 本文の
 * 文字列照合では引用キーや block scalar をすり抜けるため、実ローダーで正規化した
 * 解析結果（= エンジンが読む契約そのもの）で固定する。
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const LANGS = ['en', 'ja'] as const;
const SET_NAMES = ['readonly', 'edit', 'enable-skills'] as const;

// project 層の facet が builtins を隠すと「builtins の内容」を検証できなくなるため、
// 空の projectDir で固定する。
const emptyProjectDir = mkdtempSync(join(tmpdir(), 'takt-builtins-capabilities-'));

afterAll(() => {
  rmSync(emptyProjectDir, { recursive: true, force: true });
});

function workflowFiles(lang: (typeof LANGS)[number]): string[] {
  const dir = join(REPO_ROOT, 'builtins', lang, 'workflows');
  return readdirSync(dir).filter((file) => file.endsWith('.yaml')).map((file) => join(dir, file));
}

function loadBuiltinWorkflow(lang: (typeof LANGS)[number], filePath: string): WorkflowConfig {
  return normalizeWorkflowConfig(
    parseYaml(readFileSync(filePath, 'utf-8')),
    dirname(filePath),
    {
      lang,
      projectDir: emptyProjectDir,
      workflowDir: dirname(filePath),
      repertoireDir: join(emptyProjectDir, 'repertoire'),
    },
    undefined,
    undefined,
    undefined,
    undefined,
    { stdio: true, http: true, sse: true },
    { callableArgMode: 'discovery' },
  );
}

function resolvePreset(lang: (typeof LANGS)[number], names: string | readonly string[]): StepProviderOptions {
  const workflowDir = join(REPO_ROOT, 'builtins', lang, 'workflows');
  return resolveCapabilitySets(names, workflowDir, {
    lang,
    projectDir: emptyProjectDir,
    workflowDir,
    repertoireDir: join(emptyProjectDir, 'repertoire'),
  });
}

function agentLeaves(steps: readonly WorkflowStep[]): AgentWorkflowStep[] {
  const leaves: AgentWorkflowStep[] = [];
  for (const step of steps) {
    if (step.kind === 'system' || step.kind === 'workflow_call') {
      continue;
    }
    const agentStep = step as AgentWorkflowStep;
    if (agentStep.parallel === undefined) {
      leaves.push(agentStep);
      continue;
    }
    if (isDynamicParallelSubSteps(agentStep.parallel)) {
      leaves.push(...agentLeaves(agentStep.parallel.fixed), ...agentLeaves(agentStep.parallel.pool));
    } else {
      leaves.push(...agentLeaves(agentStep.parallel));
    }
  }
  return leaves;
}

function canon(options: StepProviderOptions | undefined): string {
  return JSON.stringify(options ?? null, (key, value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
}

// プリセット由来でない実効値が現れたら移行が壊れている。skills はリストで重なるだけなので、
// 期待値はプリセット解決の合成から組み立てる（ハードコード期待値の陳腐化を防ぐ）。
function allowedEffectiveValues(lang: (typeof LANGS)[number]): Set<string> {
  return new Set([
    canon(undefined),
    canon(resolvePreset(lang, 'readonly')),
    canon(resolvePreset(lang, 'edit')),
    canon(resolvePreset(lang, ['readonly', 'enable-skills'])),
    canon(resolvePreset(lang, ['edit', 'enable-skills'])),
  ]);
}

describe('builtin capability declarations (parsed contract)', () => {
  it('should resolve every builtin agent leaf to a bundled preset value and carry no inline provider_options', () => {
    for (const lang of LANGS) {
      const allowed = allowedEffectiveValues(lang);
      for (const filePath of workflowFiles(lang)) {
        const config = loadBuiltinWorkflow(lang, filePath);
        const workflowName = `${lang}/${filePath.split('/').pop()}`;
        for (const leaf of agentLeaves(config.steps)) {
          expect
            .soft(allowed.has(canon(leaf.providerOptions)), `${workflowName} step ${leaf.name}`)
            .toBe(true);
          // inline provider_options は direct 層に乗る。プリセット化後のビルトインでは常に空。
          expect
            .soft(leaf.directProviderOptions, `${workflowName} step ${leaf.name} direct`)
            .toBeUndefined();
        }
        expect.soft(config.providerOptions, `${workflowName} workflow_config`).toBeUndefined();
      }
    }
  });

  it('should resolve en and ja workflows to identical per-step effective options', () => {
    const enFiles = workflowFiles('en').map((file) => file.split('/').pop()!).sort();
    const jaFiles = workflowFiles('ja').map((file) => file.split('/').pop()!).sort();
    expect(jaFiles).toEqual(enFiles);
    for (const name of enFiles) {
      const en = loadBuiltinWorkflow('en', join(REPO_ROOT, 'builtins', 'en', 'workflows', name));
      const ja = loadBuiltinWorkflow('ja', join(REPO_ROOT, 'builtins', 'ja', 'workflows', name));
      const perStep = (config: WorkflowConfig): Record<string, string> =>
        Object.fromEntries(agentLeaves(config.steps).map((leaf) => [leaf.name, canon(leaf.providerOptions)]));
      expect(perStep(ja), name).toEqual(perStep(en));
    }
  });

  it('should apply the fragment edit override over the workflow readonly default in development-core', () => {
    for (const lang of LANGS) {
      const config = loadBuiltinWorkflow(
        lang,
        join(REPO_ROOT, 'builtins', lang, 'workflows', 'development-core.yaml'),
      );
      const byName = new Map(agentLeaves(config.steps).map((leaf) => [leaf.name, leaf.providerOptions]));
      expect(canon(byName.get('implement'))).toBe(canon(resolvePreset(lang, 'edit')));
      expect(canon(byName.get('replan'))).toBe(canon(resolvePreset(lang, 'readonly')));
    }
  });

  it('should keep the research workflow on readable tools with network access after migration', () => {
    for (const lang of LANGS) {
      const config = loadBuiltinWorkflow(lang, join(REPO_ROOT, 'builtins', lang, 'workflows', 'research.yaml'));
      const leaves = agentLeaves(config.steps);
      expect(leaves.length).toBeGreaterThan(0);
      for (const leaf of leaves) {
        const options = leaf.providerOptions;
        expect(options?.claude?.allowedTools, `${lang} ${leaf.name}`).toEqual(
          expect.arrayContaining(['Read', 'Grep', 'WebSearch', 'WebFetch']),
        );
        expect(options?.codex?.networkAccess, `${lang} ${leaf.name}`).toBe(true);
        expect(options?.opencode?.networkAccess, `${lang} ${leaf.name}`).toBe(true);
      }
    }
  });

  it('should ship the same capability preset contents for en and ja', () => {
    for (const name of SET_NAMES) {
      expect(canon(resolvePreset('ja', name)), name).toBe(canon(resolvePreset('en', name)));
    }
  });
});
