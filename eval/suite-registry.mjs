import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalDir = dirname(fileURLToPath(import.meta.url));

const CLASSIFICATIONS = [
  {
    tier: 'active',
    reason: '現在の共有 reviewer persona/policy の代表的な recall・precision 回帰を測る',
    suites: ['coding', 'arch', 'antipattern', 'frontend', 'cqrs', 'arch-failure-aggregation'],
  },
  {
    tier: 'active',
    reason: '現在の remediation 設計である有界計画と再発収束の意味契約を測る',
    suites: ['fix-loop-convergence', 'fix-plan-bounded-proof'],
  },
  {
    tier: 'active',
    reason: '現在の review architecture の探索範囲・証拠・裁定境界を横断して測る',
    suites: [
      'initial-review-contract-discovery',
      'testing-review-observable-evidence',
      'scope-architecture-search',
      'scope-architecture-search-none',
      'scope-architecture-search-unrelated',
      'scope-architecture-boundary',
      'review-adjudication',
      'review-adjudication-binding',
      'security-review-method',
    ],
  },
  {
    tier: 'active',
    reason: '現在の plan-to-implementation と report の契約 identity 伝播を測る',
    suites: [
      'initial-plan-contract-closure',
      'implement-contract-traceability',
      'implementation-report-contract-traceability',
    ],
  },
  {
    tier: 'active',
    reason: '現在の reviewer/fixer/companion 間の責務境界を測る',
    suites: [
      'fix-verifier-family-boundary',
      'companion-early-scan',
      'companion-testing-later-scan',
      'companion-evidence-boundary',
      'review-mode-authority',
    ],
  },
  {
    tier: 'active',
    reason: '現在の final-gate がコード充足と外部判断を区別する代表回帰を測る',
    suites: ['final-readiness-precision'],
  },
  {
    tier: 'retained',
    reason: '弱いモデルでの再走査能力を追跡する比較資産で、通常の prompt regression gate ではない',
    suites: ['rescan', 'rescan-coding'],
  },
  {
    tier: 'retained',
    reason: '個別 coder 事故から得た実装知識を保存する資産で、共有 prompt 変更時の代表集合とは重複する',
    suites: ['frontend-coder', 'cqrs-coder', 'fix-self-scan'],
  },
  {
    tier: 'retained',
    reason: '過去の remediation 事故を個別再現する知識資産で、現役 suite が現在の境界を代表する',
    suites: [
      'fix-closure',
      'fix-plan-fresh-findings',
      'fix-plan-boundary-preflight',
      'fix-plan-cause-check',
      'review-family-closure',
    ],
  },
  {
    tier: 'retained',
    reason: '過去の planning/report 事故を個別再現する知識資産で、現在の traceability 回帰と役割が重なる',
    suites: [
      'replan-contract-closure',
      'issue-plan-samples',
      'plan-report-source-authority',
      'write-tests-contract-traceability',
      'write-tests-default-priority',
      'write-tests-default-priority-codex',
      'scope-default-write-tests',
      'scope-maintenance-write-tests',
    ],
  },
  {
    tier: 'retained',
    reason: '特定の follow-up repair 事故を保存する資産で、現在の review scope 回帰と役割が重なる',
    suites: [
      'follow-up-review-repair-regression',
      'follow-up-testing-review-repair-regression',
      'initial-review-external-identity-wiring',
    ],
  },
  {
    tier: 'retained',
    reason: '旧 final-readiness 分割シナリオを保存する資産で、precision suite が現在の代表回帰である',
    suites: ['final-readiness-supervision', 'final-readiness-preservation'],
  },
  {
    tier: 'retained',
    reason: '対話的 task instruction の個別設計資産で、workflow facet の共有 regression とは独立している',
    suites: ['task-instruction-gherkin'],
  },
];

const EXECUTION_OVERRIDES = {
  coding: {
    defaultEligible: false,
    credentials: ['claude', 'codex'],
    cost: 'high',
    reason: '3モデル比較のため両CLI認証と大きな実行枠を要する',
  },
  rescan: {
    defaultEligible: false,
    credentials: ['codex', 'opencode'],
    cost: 'high',
    reason: '認証済み opencode と意図的に不安定な弱モデル比較を含む',
  },
  'rescan-coding': {
    defaultEligible: false,
    credentials: ['codex', 'opencode'],
    cost: 'high',
    reason: '認証済み opencode と意図的に不安定な弱モデル比較を含む',
  },
  'fix-self-scan': {
    defaultEligible: false,
    credentials: ['claude'],
    cost: 'standard',
    reason: 'Claude headless CLI の明示的な認証を要する',
  },
  'fix-loop-convergence': {
    defaultEligible: false,
    credentials: ['claude', 'codex'],
    cost: 'high',
    reason: '全シナリオを3モデルで測る production-condition suite である',
  },
  'fix-plan-cause-check': {
    defaultEligible: false,
    credentials: ['claude', 'codex'],
    cost: 'high',
    reason: '2つの外部CLIを使う比較 suite である',
  },
  'fix-plan-bounded-proof': {
    defaultEligible: false,
    credentials: ['claude', 'codex'],
    cost: 'high',
    reason: 'キャッシュなしの3モデル反復を行う production-condition suite である',
  },
  'initial-review-external-identity-wiring': {
    defaultEligible: false,
    credentials: ['claude', 'codex'],
    cost: 'high',
    reason: '3モデル比較のため両CLI認証と大きな実行枠を要する',
  },
  'review-adjudication-binding': {
    defaultEligible: false,
    credentials: ['claude', 'codex'],
    cost: 'high',
    reason: '3モデル比較のため両CLI認証と大きな実行枠を要する',
  },
  'security-review-method': {
    defaultEligible: false,
    credentials: ['claude', 'codex'],
    cost: 'high',
    reason: '7ケースを3モデルで測るため両CLI認証と大きな実行枠を要する',
  },
  'write-tests-default-priority': {
    defaultEligible: false,
    credentials: ['claude'],
    cost: 'standard',
    reason: 'Claude 固有事故の再現用で明示的な認証を要する',
  },
  'write-tests-default-priority-codex': {
    defaultEligible: false,
    credentials: ['codex'],
    cost: 'standard',
    reason: 'Claude 固有事故に対する明示的な比較実行である',
  },
};

const PREPARE_TARGET_OVERRIDES = {
  coding: ['coding-review'],
  arch: ['arch-review'],
  antipattern: ['antipattern-review'],
  frontend: ['frontend-review'],
  cqrs: ['cqrs-review'],
  'frontend-coder': ['frontend-implement'],
  'cqrs-coder': ['cqrs-implement'],
  'fix-loop-convergence': [],
  'final-readiness-preservation': ['final-readiness-supervision-phase2'],
  'task-instruction-gherkin': [],
};

function discoverSuiteNames() {
  return readdirSync(evalDir)
    .flatMap((fileName) => {
      const match = /^promptfooconfig\.(.+)\.yaml$/.exec(fileName);
      return match === null ? [] : [match[1]];
    })
    .sort();
}

function buildClassifications() {
  const classified = new Map();
  for (const { tier, reason, suites } of CLASSIFICATIONS) {
    for (const name of suites) {
      if (classified.has(name)) throw new Error(`Prompt eval suite classified twice: ${name}`);
      classified.set(name, { tier, reason });
    }
  }
  return classified;
}

const discoveredNames = discoverSuiteNames();
const classifications = buildClassifications();
const missing = discoveredNames.filter((name) => !classifications.has(name));
const stale = [...classifications.keys()].filter((name) => !discoveredNames.includes(name));
if (missing.length > 0 || stale.length > 0) {
  throw new Error(
    `Prompt eval registry mismatch. Unclassified: ${missing.join(', ') || '(none)'}; `
      + `missing configs: ${stale.join(', ') || '(none)'}`,
  );
}

export const PROMPT_EVAL_SUITES = Object.freeze(discoveredNames.map((name) => {
  const classification = classifications.get(name);
  const execution = EXECUTION_OVERRIDES[name] ?? {
    defaultEligible: true,
    credentials: ['codex'],
    cost: 'standard',
    reason: '通常の Codex prompt eval 実行条件で走る',
  };
  return Object.freeze({
    name,
    config: `promptfooconfig.${name}.yaml`,
    ...classification,
    execution: Object.freeze(execution),
    prepareTargets: Object.freeze(PREPARE_TARGET_OVERRIDES[name] ?? [name]),
  });
}));

export function selectPromptEvalSuites({ names = [], tier } = {}) {
  if (names.length > 0) {
    return names.map((name) => {
      const suite = PROMPT_EVAL_SUITES.find((candidate) => candidate.name === name);
      if (suite === undefined) {
        throw new Error(
          `Unknown suite "${name}". Available: ${PROMPT_EVAL_SUITES.map(({ name: id }) => id).join(', ')}`,
        );
      }
      return suite;
    });
  }
  if (tier !== undefined) return PROMPT_EVAL_SUITES.filter((suite) => suite.tier === tier);
  return PROMPT_EVAL_SUITES.filter((suite) =>
    suite.tier === 'active' && suite.execution.defaultEligible);
}

export function promptEvalPrepareTargets(suites) {
  return [...new Set(suites.flatMap(({ prepareTargets }) => prepareTargets))];
}

export const PROMPT_EVAL_TIERS = Object.freeze(['active', 'retained']);
