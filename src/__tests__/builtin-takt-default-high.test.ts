import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { validateWorkflowConfig } from '../core/workflow/engine/WorkflowValidator.js';
import { inspectWorkflowFile } from '../infra/config/loaders/workflowDoctor.js';
import { loadWorkflowFromFile } from '../infra/config/loaders/workflowFileLoader.js';

type WorkflowStep = {
  name?: string;
  kind?: string;
  call?: string;
  args?: Record<string, unknown>;
  tags?: string[];
  edit?: boolean;
  instruction?: unknown;
  persona?: unknown;
  session?: string;
  pass_previous_response?: boolean;
  team_leader?: {
    max_concurrency?: number;
    initial_max_parts?: number;
    max_total_parts?: number;
    fail_on_part_error?: boolean;
    part_tags?: string[];
    part_persona?: string;
    part_edit?: boolean;
    part_permission_mode?: string;
  };
  provider?: unknown;
  model?: unknown;
  parallel?: WorkflowStep[];
  rules?: Array<{ next?: string; return?: string; condition?: string }>;
};

type Workflow = {
  name: string;
  max_steps: number;
  initial_step: string;
  finding_contract?: { ledger_path?: string; raw_findings_path?: string };
  workflow_config?: unknown;
  steps?: WorkflowStep[];
  loop_monitors?: Array<{ cycle?: string[] }>;
};

type LocalFacetReference = {
  path: string;
  key: 'instruction' | 'persona';
  value: string;
};

const locales = ['ja', 'en'] as const;
const localWorkflows = [
  'takt-default-for-local-llm',
  'frontend-for-local-llm',
  'backend-for-local-llm',
  'backend-cqrs-for-local-llm',
  'dual-for-local-llm',
  'peer-review-for-local-llm',
] as const;
const builtinWorkflowFilesPerLocale = 61;

const genericInstructionNames = [
  'review-arch',
  'ai-antipattern-review',
  'review-coding',
  'review-implementation-semantics',
  'contract-lifecycle-review',
  'robustness-review',
] as const;

const approvedContentHashes: Record<typeof locales[number], {
  genericInstructions: Record<typeof genericInstructionNames[number], string>;
  genericArchitecturePersona: string;
  taktDefaultWorkflow: string;
}> = {
  ja: {
    genericInstructions: {
      'review-arch': '960bd48b417d3301a8be8199d0ace3a24979d15c539f72b2b9733e5961ebfe05',
      'ai-antipattern-review': '932d90634a8f8a81d298e47ed44f31b67335aeaef70c72ef5cefe1a07c86b5cf',
      'review-coding': 'd69f9237752a7e701444b0a9d20245c4e45056f5df5ffedb3957b0a76d8af75b',
      'review-implementation-semantics': '8f01a25fdf1f486e8cecc2e6b886c6f12372a080d2cc2d2d279014cc85bdaa65',
      'contract-lifecycle-review': '4af1eb2aa808d6ea5a42a9e15d70fa5f41919215ae36054918a668c4dc59d7cb',
      'robustness-review': '45e5af49cdfa3f972d1a9b8e237786d5c0267132fde9c67c857a48f58469cced',
    },
    genericArchitecturePersona: '4f1a7eb34727fc16d67e09198872869321bd21f9bfc7856f6b6cbe306fe0dfde',
    taktDefaultWorkflow: '72eec088939c61e9bb4dae5045375bad2a6accd9d6e9cc29052d23f584bb2d05',
  },
  en: {
    genericInstructions: {
      'review-arch': 'e4792be717e3f9a8f23ef41503f14f15c78d188b96f04032937ce13af1e5c969',
      'ai-antipattern-review': '16964536dd23e09fe06117d74cb883a69cea06befaec633abba9fb5370fa8cca',
      'review-coding': '13803a3aa8d0204846cb2db6765c4f308cfd564e894fcacf192bdb2af40f02ce',
      'review-implementation-semantics': '144249776f6603c37abac79121e0ee040ff63795724f7dac667803f2feda1a9c',
      'contract-lifecycle-review': '10c0207be2c4ede356054b35bf26c642fe14f30119c5063234c402299c4c1783',
      'robustness-review': 'be6ddf378b4af0bf3f8945790f68b32f31bb59b908f738381847f82083ba62ee',
    },
    genericArchitecturePersona: 'f5890219e61509a0c3e19efd2235bd020c212eea8d630b5ce5d5a007d455c41d',
    taktDefaultWorkflow: '4025df44c4f4eed0a6f6a33d481b18b60f19334165081a7855d95460ac18fcad',
  },
};

function localFacetReference(
  path: string,
  key: LocalFacetReference['key'],
  value: string,
): LocalFacetReference {
  return { path, key, value };
}

const localFacetReferences: Record<typeof localWorkflows[number], LocalFacetReference[]> = {
  'takt-default-for-local-llm': [
    localFacetReference('workflow.steps[3].instruction', 'instruction', 'ai-antipattern-review-for-local-llm'),
    localFacetReference('workflow.steps[5].persona', 'persona', 'architecture-reviewer-for-local-llm'),
    localFacetReference('workflow.steps[6].parallel[0].persona', 'persona', 'architecture-reviewer-for-local-llm'),
    localFacetReference('workflow.steps[6].parallel[0].instruction', 'instruction', 'review-arch-for-local-llm'),
    localFacetReference('workflow.steps[6].parallel[1].instruction', 'instruction', 'ai-antipattern-review-for-local-llm'),
    localFacetReference('workflow.steps[6].parallel[2].instruction', 'instruction', 'review-coding-for-local-llm'),
    localFacetReference('workflow.steps[6].parallel[3].instruction', 'instruction', 'review-implementation-semantics-for-local-llm'),
    localFacetReference('workflow.steps[6].parallel[4].instruction', 'instruction', 'contract-lifecycle-review-for-local-llm'),
    localFacetReference('workflow.steps[6].parallel[5].instruction', 'instruction', 'robustness-review-for-local-llm'),
  ],
  'frontend-for-local-llm': [
    localFacetReference('workflow.steps[3].instruction', 'instruction', 'ai-antipattern-review-for-local-llm'),
    localFacetReference('workflow.steps[5].persona', 'persona', 'architecture-reviewer-for-local-llm'),
    localFacetReference('workflow.steps[6].parallel[1].instruction', 'instruction', 'ai-antipattern-review-for-local-llm'),
    localFacetReference('workflow.steps[6].parallel[2].instruction', 'instruction', 'review-coding-for-local-llm'),
    localFacetReference('workflow.steps[6].parallel[3].instruction', 'instruction', 'review-implementation-semantics-for-local-llm'),
  ],
  'backend-for-local-llm': [
    localFacetReference('workflow.steps[3].instruction', 'instruction', 'ai-antipattern-review-for-local-llm'),
    localFacetReference('workflow.steps[5].persona', 'persona', 'architecture-reviewer-for-local-llm'),
    localFacetReference('workflow.steps[6].parallel[0].persona', 'persona', 'architecture-reviewer-for-local-llm'),
    localFacetReference('workflow.steps[6].parallel[0].instruction', 'instruction', 'review-arch-for-local-llm'),
    localFacetReference('workflow.steps[6].parallel[1].instruction', 'instruction', 'ai-antipattern-review-for-local-llm'),
    localFacetReference('workflow.steps[6].parallel[2].instruction', 'instruction', 'review-coding-for-local-llm'),
    localFacetReference('workflow.steps[6].parallel[3].instruction', 'instruction', 'review-implementation-semantics-for-local-llm'),
  ],
  'backend-cqrs-for-local-llm': [
    localFacetReference('workflow.steps[3].instruction', 'instruction', 'ai-antipattern-review-for-local-llm'),
    localFacetReference('workflow.steps[5].persona', 'persona', 'architecture-reviewer-for-local-llm'),
    localFacetReference('workflow.steps[6].parallel[1].instruction', 'instruction', 'ai-antipattern-review-for-local-llm'),
    localFacetReference('workflow.steps[6].parallel[2].instruction', 'instruction', 'review-coding-for-local-llm'),
    localFacetReference('workflow.steps[6].parallel[3].instruction', 'instruction', 'review-implementation-semantics-for-local-llm'),
  ],
  'dual-for-local-llm': [
    localFacetReference('workflow.steps[3].instruction', 'instruction', 'ai-antipattern-review-for-local-llm'),
    localFacetReference('workflow.steps[5].persona', 'persona', 'architecture-reviewer-for-local-llm'),
    localFacetReference('workflow.steps[6].parallel[0].persona', 'persona', 'architecture-reviewer-for-local-llm'),
    localFacetReference('workflow.steps[6].parallel[0].instruction', 'instruction', 'review-arch-for-local-llm'),
    localFacetReference('workflow.steps[6].parallel[2].instruction', 'instruction', 'ai-antipattern-review-for-local-llm'),
    localFacetReference('workflow.steps[6].parallel[3].instruction', 'instruction', 'review-coding-for-local-llm'),
    localFacetReference('workflow.steps[6].parallel[4].instruction', 'instruction', 'review-implementation-semantics-for-local-llm'),
  ],
  'peer-review-for-local-llm': [
    localFacetReference('workflow.steps[0].parallel[0].persona', 'persona', 'architecture-reviewer-for-local-llm'),
    localFacetReference('workflow.steps[0].parallel[0].instruction', 'instruction', 'review-arch-for-local-llm'),
    localFacetReference('workflow.steps[0].parallel[4].instruction', 'instruction', 'review-coding-for-local-llm'),
    localFacetReference('workflow.steps[0].parallel[5].instruction', 'instruction', 'review-implementation-semantics-for-local-llm'),
    localFacetReference('workflow.steps[0].parallel[6].instruction', 'instruction', 'ai-antipattern-review-for-local-llm'),
  ],
};

const localInstructionMarkers = {
  ja: {
    'review-arch': ['全章の判定基準', '未確認範囲', '現在の根拠'],
    'ai-antipattern-review': ['adapter、normalizer、builder、外部通知、中断・キャンセル経路', '全章', '累積差分全体'],
    'review-coding': ['公開入口・実行モード', '状態遷移と副作用', '成功、失敗、中断、cleanup、残留物'],
    'review-implementation-semantics': ['生成した ID、token、key', '未確認範囲', '現在の根拠'],
    'contract-lifecycle-review': ['producer、validator、consumer、対応テスト', 'owner、所有権移譲、last consumer、release/persist', '成功・失敗・中断・再試行'],
    'robustness-review': ['hard cap、強制位置、cap 前コスト、metadata 異常時、対応テスト', '失敗型、継続可否、caller/user への可視性、部分成功結果', '無言の skip'],
  },
  en: {
    'review-arch': ["every chapter's criteria", 'unverified scope', 'current evidence'],
    'ai-antipattern-review': ['adapter, normalizer, builder, external notification, and interruption/cancellation path', 'every Policy / Knowledge chapter', 'full cumulative diff'],
    'review-coding': ['public entries or execution modes', 'state-transition and side-effect equivalence classes', 'success, failure, interruption, cleanup, and residual artifacts'],
    'review-implementation-semantics': ['Generated IDs, tokens, and keys', 'unverified scope', 'current evidence'],
    'contract-lifecycle-review': ['producer, validator, consumer, and corresponding test', 'owner, ownership transfer, last consumer, release or persistence point', 'success, failure, interruption, and retry paths'],
    'robustness-review': ['hard cap, enforcement point, pre-cap cost, metadata failure behavior, and corresponding test', 'failure type, whether work may continue, caller/user visibility, and partial-success result', 'Silent skips'],
  },
} as const;

function readYaml<T>(locale: typeof locales[number], file: string): T {
  return parseYaml(readFileSync(join(process.cwd(), 'builtins', locale, file), 'utf-8')) as T;
}

function stepByName(steps: WorkflowStep[], name: string): WorkflowStep {
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`Missing step: ${name}`);
  }
  return step;
}

function withoutTeamLeaderOverrides(step: WorkflowStep): Record<string, unknown> {
  const overriddenFields = new Set([
    'tags',
    'instruction',
    'session',
    'pass_previous_response',
    'team_leader',
  ]);
  return Object.fromEntries(
    Object.entries(step).filter(([key]) => !overriddenFields.has(key)),
  );
}

function isLocalFacetReference(value: unknown): value is string {
  return typeof value === 'string' && value.endsWith('-for-local-llm');
}

function collectLocalFacetReferences(value: unknown, path = 'workflow'): LocalFacetReference[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectLocalFacetReferences(item, `${path}[${index}]`));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = `${path}.${key}`;
    const reference = (key === 'instruction' || key === 'persona') && isLocalFacetReference(child)
      ? [localFacetReference(childPath, key, child)]
      : [];
    return [...reference, ...collectLocalFacetReferences(child, childPath)];
  });
}

function listBuiltinWorkflows(locale: typeof locales[number]): Array<{ file: string; workflow: Workflow }> {
  const workflowsDir = join(process.cwd(), 'builtins', locale, 'workflows');
  const collectWorkflowFiles = (dir: string, parent = ''): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = join(parent, entry.name);
      return entry.isDirectory()
        ? collectWorkflowFiles(join(dir, entry.name), relativePath)
        : entry.isFile() && entry.name.endsWith('.yaml') ? [relativePath] : [];
    });

  return collectWorkflowFiles(workflowsDir)
    .sort()
    .map((file) => ({ file, workflow: readYaml<Workflow>(locale, join('workflows', file)) }));
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function hasFixedProviderOrModelOnStep(steps: WorkflowStep[]): boolean {
  return steps.some((step) => (
    step.provider !== undefined
    || step.model !== undefined
    || hasFixedProviderOrModelOnStep(step.parallel ?? [])
  ));
}

function createProjectWithLanguage(locale: typeof locales[number]): string {
  const projectDir = mkdtempSync(join(tmpdir(), 'takt-default-high-'));
  const configDir = join(projectDir, '.takt');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.yaml'), `language: ${locale}\n`, 'utf-8');
  return projectDir;
}

describe('takt-default-high builtin workflow', () => {
  for (const locale of locales) {
    it(`${locale} uses the enhanced direct implementation and six-reviewer design`, () => {
      const workflow = readYaml<Workflow>(locale, join('workflows', 'takt-default-high.yaml'));
      const steps = workflow.steps ?? [];
      const implement = stepByName(steps, 'implement');
      const fix = stepByName(steps, 'fix');
      const reviewers = stepByName(steps, 'reviewers');
      const finalGate = stepByName(steps, 'final-gate');
      const finalGateWorkflow = readYaml<Workflow>(
        locale,
        join('workflows', 'merge-readiness-finding-contract-final-gate.yaml'),
      );
      const mergeReadiness = stepByName(finalGateWorkflow.steps ?? [], 'merge-readiness-review');
      const supervise = stepByName(finalGateWorkflow.steps ?? [], 'supervise');

      expect(workflow).toMatchObject({
        name: 'takt-default-high',
        max_steps: 200,
        finding_contract: {
          ledger_path: '.takt/findings/takt-default-high.json',
          raw_findings_path: '.takt/findings/takt-default-high/raw',
        },
      });
      expect(implement).toMatchObject({ instruction: 'implement', session: 'compact' });
      expect(fix).toMatchObject({ instruction: 'fix', session: 'compact' });
      expect(implement.team_leader).toBeUndefined();
      expect(fix.team_leader).toBeUndefined();
      expect(steps.map((step) => step.name)).not.toContain('ai-antipattern-review-1st');

      expect(reviewers.parallel?.map((step) => step.name)).toEqual([
        'arch-review',
        'ai-antipattern-review',
        'coding-review',
        'implementation-semantics-review',
        'contract-lifecycle-review',
        'robustness-review',
      ]);
      expect(reviewers.parallel?.every((step) => step.session === 'compact')).toBe(true);
      expect(reviewers.parallel?.map((step) => step.instruction)).toEqual([
        'review-arch',
        'ai-antipattern-review',
        'review-coding',
        'review-implementation-semantics',
        'contract-lifecycle-review',
        'robustness-review',
      ]);
      expect(reviewers.parallel?.some((step) => isLocalFacetReference(step.persona))).toBe(false);
      expect(finalGate).toMatchObject({
        kind: 'workflow_call',
        call: 'merge-readiness-finding-contract-final-gate',
        args: { supervise_knowledge: ['architecture', 'takt'] },
      });
      expect(mergeReadiness.parallel).toBeUndefined();
      expect(mergeReadiness.rules?.find((rule) => rule.condition?.startsWith('approved'))?.next).toBe('supervise');
      expect(mergeReadiness.rules?.find((rule) => rule.condition?.startsWith('needs_fix'))?.return).toBe('needs_fix');
      expect(supervise.instruction).toBe('supervise-finding-contract');
      expect(supervise.rules?.find((rule) => rule.condition?.startsWith('approved'))?.next).toBe('COMPLETE');
      expect(hasFixedProviderOrModelOnStep(steps)).toBe(false);

      expect(workflow.loop_monitors?.map((monitor) => monitor.cycle)).toEqual([
        ['plan', 'write_tests', 'implement', 'reviewers', 'fix'],
        ['reviewers', 'fix'],
        ['reviewers', 'final-gate', 'fix'],
      ]);
      expect(reviewers.rules?.map((rule) => rule.next)).toEqual([
        'final-gate', 'final-gate', 'NEEDS_ADJUDICATION', 'NEEDS_ADJUDICATION',
        'plan', 'fix', 'fix', 'finding-conflict-adjudication', 'ABORT',
      ]);
      expect(mergeReadiness.rules?.map((rule) => rule.next)).toContain('NEEDS_ADJUDICATION');
      expect(supervise.rules?.map((rule) => rule.next)).toContain('COMPLETE');
      expect(supervise.rules?.map((rule) => rule.next)).toContain('NEEDS_ADJUDICATION');
    });

    it(`${locale} uses Team Leaders only for implementation and fixes in takt-default-team-high`, () => {
      const direct = readYaml<Workflow>(locale, join('workflows', 'takt-default-high.yaml'));
      const team = readYaml<Workflow>(locale, join('workflows', 'takt-default-team-high.yaml'));
      const directSteps = direct.steps ?? [];
      const teamSteps = team.steps ?? [];
      const directImplement = stepByName(directSteps, 'implement');
      const directFix = stepByName(directSteps, 'fix');
      const implement = stepByName(teamSteps, 'implement');
      const fix = stepByName(teamSteps, 'fix');

      expect(team).toMatchObject({
        name: 'takt-default-team-high',
        max_steps: 200,
        initial_step: 'plan',
        finding_contract: {
          ledger_path: '.takt/findings/takt-default-team-high.json',
          raw_findings_path: '.takt/findings/takt-default-team-high/raw',
        },
      });
      expect(teamSteps.map((step) => step.name)).toEqual(directSteps.map((step) => step.name));
      expect(team.loop_monitors).toEqual(direct.loop_monitors);
      for (const name of ['plan', 'write_tests', 'reviewers', 'final-gate']) {
        expect(stepByName(teamSteps, name)).toEqual(stepByName(directSteps, name));
      }
      expect(withoutTeamLeaderOverrides(implement)).toEqual(withoutTeamLeaderOverrides(directImplement));
      expect(withoutTeamLeaderOverrides(fix)).toEqual(withoutTeamLeaderOverrides(directFix));

      const expectedTeamLeader = {
        max_concurrency: 2,
        initial_max_parts: 2,
        max_total_parts: 6,
        fail_on_part_error: false,
        part_tags: ['coding'],
        part_persona: 'coder',
        part_edit: true,
        part_permission_mode: 'edit',
      };
      expect(implement).toMatchObject({
        tags: ['leader'],
        edit: true,
        instruction: 'team-leader-implement',
        pass_previous_response: true,
        team_leader: expectedTeamLeader,
      });
      expect(fix).toMatchObject({
        tags: ['leader'],
        edit: true,
        instruction: 'team-leader-fix',
        team_leader: expectedTeamLeader,
      });
      expect(implement.session).toBeUndefined();
      expect(fix.session).toBeUndefined();
      expect(fix.pass_previous_response).toBeUndefined();
      expect(teamSteps.map((step) => step.name)).not.toContain('ai-antipattern-review-1st');
      expect(collectLocalFacetReferences(team)).toEqual([]);
      expect(hasFixedProviderOrModelOnStep(teamSteps)).toBe(false);
      expect(team.workflow_config).toBeUndefined();
    });

    it(`${locale} provides a Finding Contract review/fix entrypoint for the enhanced direct design`, () => {
      const workflow = readYaml<Workflow>(locale, join('workflows', 'review-fix-takt-default-high.yaml'));
      const reviewFixDefault = readYaml<Workflow>(locale, join('workflows', 'review-fix-takt-default.yaml'));
      const taktDefaultHigh = readYaml<Workflow>(locale, join('workflows', 'takt-default-high.yaml'));
      const steps = workflow.steps ?? [];
      const gather = stepByName(steps, 'gather');
      const reviewers = stepByName(steps, 'reviewers');

      expect(workflow).toMatchObject({
        name: 'review-fix-takt-default-high',
        initial_step: 'gather',
        max_steps: 200,
        finding_contract: {
          ledger_path: '.takt/findings/review-fix-takt-default-high.json',
          raw_findings_path: '.takt/findings/review-fix-takt-default-high/raw',
        },
      });
      expect(steps.map((step) => step.name)).toEqual([
        'gather',
        'plan',
        'write_tests',
        'implement',
        'reviewers',
        'final-gate',
        'fix',
      ]);
      expect(gather).toMatchObject({
        name: 'gather',
        persona: 'planner',
        instruction: 'gather-review',
        edit: false,
      });
      expect(gather.rules?.map((rule) => rule.next)).toEqual(['plan', 'ABORT']);
      expect(gather).toEqual(stepByName(reviewFixDefault.steps ?? [], 'gather'));
      expect(steps.slice(1)).toEqual(taktDefaultHigh.steps);
      expect(reviewers.parallel?.map((step) => step.name)).toEqual([
        'arch-review',
        'ai-antipattern-review',
        'coding-review',
        'implementation-semantics-review',
        'contract-lifecycle-review',
        'robustness-review',
      ]);
      expect(reviewers.rules?.map((rule) => rule.next)).toContain('fix');
      expect(reviewers.rules?.map((rule) => rule.next)).toContain('final-gate');
    });

    it(`${locale} restricts local facets to the exact workflow and role mapping`, () => {
      const workflows = listBuiltinWorkflows(locale);
      expect(workflows).toHaveLength(builtinWorkflowFilesPerLocale);
      const workflowNames = new Set<string>();
      const localReferencesByFile = new Map(
        workflows.map(({ file, workflow }) => {
          expect(workflow.name, `${file} workflow name`).toBe(basename(file, '.yaml'));
          expect(workflowNames.has(workflow.name), `${file} workflow name must be unique`).toBe(false);
          workflowNames.add(workflow.name);
          return [file, collectLocalFacetReferences(workflow)] as const;
        }),
      );
      const actualLocalWorkflowFiles = [...localReferencesByFile.entries()]
        .filter(([, references]) => references.length > 0)
        .map(([file]) => file)
        .sort();

      expect(actualLocalWorkflowFiles).toEqual(localWorkflows.map((name) => `${name}.yaml`).sort());

      for (const name of localWorkflows) {
        const file = `${name}.yaml`;
        expect(localReferencesByFile.get(file), `${file} local role mapping`).toEqual(localFacetReferences[name]);
      }
      for (const [file, references] of localReferencesByFile) {
        if (!localWorkflows.includes(basename(file, '.yaml') as typeof localWorkflows[number])) {
          expect(references, `${file} must not reference a local-only facet`).toEqual([]);
        }
      }
    });

    it(`${locale} preserves generic reviewer capabilities while local facets add focused safeguards`, () => {
      const localMarkers = localInstructionMarkers[locale];
      const approvedHashes = approvedContentHashes[locale];

      for (const instruction of genericInstructionNames) {
        const genericPath = join(
          process.cwd(),
          'builtins',
          locale,
          'facets',
          'instructions',
          `${instruction}.md`,
        );
        const local = readFileSync(
          join(process.cwd(), 'builtins', locale, 'facets', 'instructions', `${instruction}-for-local-llm.md`),
          'utf-8',
        );

        expect(sha256File(genericPath), `${instruction} approved generic content`).toBe(
          approvedHashes.genericInstructions[instruction],
        );
        for (const marker of localMarkers[instruction]) {
          expect(local, `${instruction} local safeguard: ${marker}`).toContain(marker);
        }
      }

      const genericArchitecturePath = join(
        process.cwd(),
        'builtins',
        locale,
        'facets',
        'personas',
        'architecture-reviewer.md',
      );
      const localArchitecture = readFileSync(
        join(process.cwd(), 'builtins', locale, 'facets', 'personas', 'architecture-reviewer-for-local-llm.md'),
        'utf-8',
      );
      expect(sha256File(genericArchitecturePath), 'approved generic architecture persona content').toBe(
        approvedHashes.genericArchitecturePersona,
      );
      const localBoundaryMarkers = locale === 'ja'
        ? ['役割の境界', '呼び出しチェーン・配線漏れの検証', '仕様準拠の確認']
        : ['Role Boundaries', 'missing wiring', 'specification compliance'];
      for (const marker of localBoundaryMarkers) {
        expect(localArchitecture, `local architecture persona boundary: ${marker}`).toContain(marker);
      }
    });

    it(`${locale} keeps takt-default's public orchestration contract unchanged`, () => {
      const workflowPath = join(process.cwd(), 'builtins', locale, 'workflows', 'takt-default.yaml');
      const workflow = readYaml<Workflow>(locale, join('workflows', 'takt-default.yaml'));
      const steps = workflow.steps ?? [];
      const plan = stepByName(steps, 'plan');
      const writeTests = stepByName(steps, 'write_tests');
      const draft = stepByName(steps, 'draft');
      const peerReview = stepByName(steps, 'peer-review');

      expect(sha256File(workflowPath), 'approved takt-default workflow content').toBe(
        approvedContentHashes[locale].taktDefaultWorkflow,
      );
      expect(workflow).toMatchObject({
        name: 'takt-default',
        max_steps: 50,
        initial_step: 'plan',
        workflow_config: {
          provider_options: {
            codex: { network_access: true },
            opencode: { network_access: true },
          },
        },
      });
      expect(workflow.finding_contract).toBeUndefined();
      expect(steps.map((step) => step.name)).toEqual(['plan', 'write_tests', 'draft', 'peer-review']);
      expect(plan).toMatchObject({ name: 'plan', persona: 'planner', instruction: 'plan', edit: false });
      expect(plan.rules?.map((rule) => rule.next)).toEqual(['write_tests', 'COMPLETE', 'ABORT']);
      expect(writeTests).toMatchObject({
        name: 'write_tests',
        persona: 'coder',
        instruction: 'write-tests-first',
        edit: true,
        required_permission_mode: 'edit',
      });
      expect(writeTests.rules?.map((rule) => rule.next)).toEqual(['draft', 'draft', 'plan', 'write_tests']);
      expect(draft).toMatchObject({ name: 'draft', kind: 'workflow_call', call: 'draft' });
      expect(draft.rules?.map((rule) => rule.next)).toEqual(['peer-review', 'plan', 'ABORT']);
      expect(peerReview).toMatchObject({ name: 'peer-review', kind: 'workflow_call', call: 'peer-review' });
      expect(peerReview.rules?.map((rule) => rule.next)).toEqual(['COMPLETE', 'plan', 'ABORT']);
    });

    it(`${locale} loads and doctors high workflows through the standard validation path`, () => {
      const projectDir = createProjectWithLanguage(locale);

      try {
        for (const name of ['takt-default-high', 'takt-default-team-high']) {
          const workflowPath = join(process.cwd(), 'builtins', locale, 'workflows', `${name}.yaml`);
          const workflow = loadWorkflowFromFile(workflowPath, projectDir);
          expect(workflow).toMatchObject({ name, initialStep: 'plan', maxSteps: 200 });
          expect(() => validateWorkflowConfig(workflow, {
            projectCwd: projectDir,
            workflowCallResolver: () => null,
          })).not.toThrow();
          expect(inspectWorkflowFile(workflowPath, projectDir).diagnostics).toEqual([]);
        }
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });

    it(`${locale} merge-readiness contract retains the six fixed axes within 30 body lines`, () => {
      const contract = readFileSync(
        join(process.cwd(), 'builtins', locale, 'facets', 'output-contracts', 'merge-readiness-review-finding-contract.md'),
        'utf-8',
      );
      const bodyLines = contract.split('\n').filter((line) => line !== '' && line !== '```markdown' && line !== '```');
      const axes = locale === 'ja'
        ? ['要求充足', '既存契約・既存フローへの影響', 'テスト・検証', '要求外変更・スコープクリープ', '保守可能性・将来変更容易性', 'セキュリティ・データ保護・運用リスク']
        : ['Requirement fulfillment', 'Impact on existing contracts and flows', 'Tests and verification', 'Out-of-scope changes and scope creep', 'Maintainability and ease of future change', 'Security, data protection, and operational risk'];

      expect(bodyLines.length).toBeLessThanOrEqual(30);
      for (const axis of axes) {
        expect(contract).toContain(axis);
      }
      expect(contract).toContain('Observed Findings');
      expect(contract).toContain('Resolution Confirmations');
      expect(contract).toContain('1:1');
      expect(contract).toContain('APPROVE');
      expect(contract).toContain('REJECT');
    });
  }
});
