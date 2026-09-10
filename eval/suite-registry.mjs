import { readdirSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalDir = dirname(fileURLToPath(import.meta.url));

const CLASSIFICATIONS = [
  {
    tier: 'active',
    reason: '現在の共有 reviewer persona/policy の代表的な recall・precision 回帰を測る',
    suites: ['coding', 'arch', 'antipattern', 'antipattern-wording-tests', 'frontend', 'cqrs', 'arch-failure-aggregation'],
  },
  {
    tier: 'active',
    reason: '現在の remediation 設計である有界計画と再発収束の意味契約を測る',
    suites: [
      'fix-loop-convergence',
      'fix-plan-bounded-proof',
      'fix-plan-impact-closure-primary',
      'fix-plan-impact-closure-heldout',
    ],
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
      'review-adjudication-report',
      'review-adjudication-binding',
      'security-review-method',
      'review-impact-path-coverage',
      'db-pagination',
      'db-pagination-adjudication',
      'db-pagination-implement',
      'resource-flow-review',
      'resource-flow-adjudication',
      'evidence-judgment',
    ],
  },
  {
    tier: 'active',
    reason: '現在の plan-to-implementation と report の契約 identity 伝播を測る',
    suites: [
      'initial-plan-contract-closure',
      'implement-contract-traceability',
      'implementation-report-contract-traceability',
      'completion-scope-routing',
      'completion-scope-structured',
      'implement-scope-actions',
    ],
  },
  {
    tier: 'active',
    reason: '変化を名指しし、その後も状態に合わせて振る舞うことを求め、同じ実体が存続する契約の発火・誤発火・証拠境界を測る',
    suites: [
      'state-after-event-plan',
      'state-after-event-plan-config',
      'state-after-event-write-tests',
      'state-after-event-testing-review',
    ],
  },
  {
    tier: 'active',
    reason: '現在の fix-verifier の状態閉包・経路判定・証拠境界を測る',
    suites: [
      'fix-verifier-family-boundary',
      'fix-verifier-state-closure',
      'fix-verifier-state-routing',
      'fix-verifier-model-matrix',
      'fix-verifier-routing-model-matrix',
      'fix-verification-scope',
      'fix-verification-current-diff-regression',
      'fix-verification-preserved-condition',
      'remediation-evidence',
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
  'resource-flow-review': {
    defaultEligible: false,
    credentials: ['codex'],
    cost: 'standard',
    reason: 'DB以外の取得・保持境界と正当な全量処理を設計レビューで比較する',
  },
  'resource-flow-adjudication': {
    defaultEligible: false,
    credentials: ['codex'],
    cost: 'standard',
    reason: '全量処理の誤検知を含めて資源境界の指摘を裁定する',
  },
  'db-pagination-adjudication': {
    defaultEligible: false,
    credentials: ['codex'],
    cost: 'standard',
    reason: 'DB全件取得の指摘を性能要件の不在だけで免除しないか裁定を比較する',
  },
  'db-pagination-implement': {
    defaultEligible: false,
    credentials: ['codex'],
    cost: 'high',
    reason: '隔離したSQLiteプロジェクトで生成コードの返却件数とDB取得行数を比較する',
  },
  'db-pagination': {
    defaultEligible: false,
    credentials: ['codex'],
    cost: 'standard',
    reason: 'DB取得境界の検出と有界な切り出しの許容を実モデルで比較する',
  },
  'implement-scope-actions': {
    defaultEligible: false,
    credentials: ['codex'],
    cost: 'high',
    reason: '隔離した書き込み可能なプロジェクトで実装・検証の行動を実モデル評価する',
  },
  'completion-scope-structured': {
    defaultEligible: false,
    credentials: ['codex'],
    cost: 'standard',
    reason: '本番の構造化応答で実装完了と再計画のスコープ判定を比較する',
  },
  'completion-scope-routing': {
    defaultEligible: false,
    credentials: ['codex'],
    cost: 'standard',
    reason: '実装完了と再計画のスコープ判定を固定レポートで比較する',
  },
  'evidence-judgment': {
    defaultEligible: false,
    credentials: ['codex'],
    cost: 'standard',
    reason: '共通判断ポリシーを役割別の固定入力で評価する',
  },
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
  'remediation-evidence': {
    defaultEligible: false,
    credentials: ['codex'],
    cost: 'standard',
    reason: '共有 remediation 指示の変更時に実行する、固定証跡による判定比較である',
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
  'fix-plan-impact-closure-primary': {
    defaultEligible: false,
    credentials: ['codex'],
    cost: 'high',
    reason: 'Codex Luna Max の read-only isolated 実行で独立した影響経路の計画を検証する',
  },
  'fix-plan-impact-closure-heldout': {
    defaultEligible: false,
    credentials: ['codex'],
    cost: 'high',
    reason: '主ケースと異なる構造で影響経路計画の汎化と過剰範囲を検証する',
  },
  'fix-plan-fresh-findings': {
    defaultEligible: false,
    credentials: ['claude', 'codex'],
    cost: 'high',
    reason: '3モデル比較のため両CLI認証と大きな実行枠を要する',
  },
  'fix-verifier-model-matrix': {
    defaultEligible: false,
    credentials: ['claude', 'codex', 'opencode'],
    cost: 'high',
    reason: 'Claude・Codex・opencode の複数モデル比較を要する',
  },
  'fix-verifier-routing-model-matrix': {
    defaultEligible: false,
    credentials: ['claude', 'codex', 'opencode'],
    cost: 'high',
    reason: 'Claude・Codex・opencode の複数モデル比較を要する',
  },
  'review-impact-path-coverage': {
    defaultEligible: false,
    credentials: ['claude', 'codex'],
    cost: 'high',
    reason: '3モデル比較のため両CLI認証と大きな実行枠を要する',
  },
  'follow-up-review-repair-regression': {
    defaultEligible: false,
    credentials: ['claude', 'codex'],
    cost: 'high',
    reason: '3モデル比較のため両CLI認証と大きな実行枠を要する',
  },
  'follow-up-testing-review-repair-regression': {
    defaultEligible: false,
    credentials: ['claude', 'codex'],
    cost: 'high',
    reason: '3モデル比較のため両CLI認証と大きな実行枠を要する',
  },
  'review-adjudication': {
    defaultEligible: false,
    credentials: ['claude', 'codex'],
    cost: 'high',
    reason: '3モデル比較のため両CLI認証と大きな実行枠を要する',
  },
  'review-adjudication-report': {
    defaultEligible: false,
    credentials: ['claude', 'codex'],
    cost: 'high',
    reason: '3モデル比較のため両CLI認証と大きな実行枠を要する',
  },
  'fix-verification-scope': {
    defaultEligible: false,
    credentials: ['claude', 'codex'],
    cost: 'high',
    reason: '3モデル比較のため両CLI認証と大きな実行枠を要する',
  },
  'fix-verification-current-diff-regression': {
    defaultEligible: false,
    credentials: ['claude', 'codex'],
    cost: 'high',
    reason: '3モデル比較のため両CLI認証と大きな実行枠を要する',
  },
  'fix-verification-preserved-condition': {
    defaultEligible: false,
    credentials: ['claude', 'codex'],
    cost: 'high',
    reason: '3モデル比較のため両CLI認証と大きな実行枠を要する',
  },
  'initial-review-external-identity-wiring': {
    defaultEligible: false,
    credentials: ['claude', 'codex'],
    cost: 'high',
    reason: '3モデル比較のため両CLI認証と大きな実行枠を要する',
  },
  'state-after-event-plan': {
    defaultEligible: false,
    credentials: ['claude', 'codex'],
    cost: 'high',
    reason: 'Claude Opus と Codex Luna を含む production-condition の計画比較を行う',
  },
  'state-after-event-plan-config': {
    defaultEligible: false,
    credentials: ['claude', 'codex'],
    cost: 'high',
    reason: 'Claude Opus と Codex Luna を含む production-condition の設定変更計画比較を行う',
  },
  'state-after-event-testing-review': {
    defaultEligible: false,
    credentials: ['claude', 'codex'],
    cost: 'high',
    reason: 'Claude Opus と Codex Luna を含む production-condition の testing-review 比較を行う',
  },
  'state-after-event-write-tests': {
    defaultEligible: false,
    credentials: ['codex'],
    cost: 'standard',
    reason: 'mutable artifact assertion を Codex SDK の workspace-write で実行する',
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
  'antipattern-wording-tests': {
    defaultEligible: false,
    credentials: ['claude', 'codex'],
    cost: 'standard',
    reason: 'Claude Opus と Codex Luna の2モデル比較のため両CLI認証を要する',
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
  'completion-scope-structured': [],
  'completion-scope-routing': [],
  'evidence-judgment': [],
  coding: ['coding-review'],
  arch: ['arch-review'],
  antipattern: ['antipattern-review'],
  'antipattern-wording-tests': ['antipattern-review'],
  frontend: ['frontend-review'],
  cqrs: ['cqrs-review'],
  'frontend-coder': ['frontend-implement'],
  'cqrs-coder': ['cqrs-implement'],
  'fix-loop-convergence': [],
  'remediation-evidence': [],
  'fix-verifier-model-matrix': ['fix-verifier-state-closure'],
  'fix-verifier-routing-model-matrix': ['fix-verifier-state-routing'],
  'final-readiness-preservation': ['final-readiness-supervision-phase2'],
  'review-adjudication-report': ['review-adjudication-phase2'],
  'task-instruction-gherkin': [],
};

export function discoverPromptEvalConfigs(rootDir = evalDir) {
  const configs = new Map();

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;

      const name = basename(entry.name).replace(/\.ya?ml$/, '');
      const config = relative(rootDir, path).split(sep).join('/');
      if (configs.has(name)) {
        throw new Error(
          `Prompt eval suite name duplicated: ${name} (${configs.get(name)}, ${config})`,
        );
      }
      configs.set(name, config);
    }
  }

  visit(join(rootDir, 'agents'));
  visit(join(rootDir, 'scenarios'));
  return [...configs.entries()]
    .map(([name, config]) => ({ name, config }))
    .sort((left, right) => left.name.localeCompare(right.name));
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

const discoveredConfigs = discoverPromptEvalConfigs();
const discoveredNames = discoveredConfigs.map(({ name }) => name);
const classifications = buildClassifications();
const missing = discoveredNames.filter((name) => !classifications.has(name));
const stale = [...classifications.keys()].filter((name) => !discoveredNames.includes(name));
if (missing.length > 0 || stale.length > 0) {
  throw new Error(
    `Prompt eval registry mismatch. Unclassified: ${missing.join(', ') || '(none)'}; `
      + `missing configs: ${stale.join(', ') || '(none)'}`,
  );
}

export const PROMPT_EVAL_SUITES = Object.freeze(discoveredConfigs.map(({ name, config }) => {
  const classification = classifications.get(name);
  const execution = EXECUTION_OVERRIDES[name] ?? {
    defaultEligible: true,
    credentials: ['codex'],
    cost: 'standard',
    reason: '通常の Codex prompt eval 実行条件で走る',
  };
  return Object.freeze({
    name,
    config,
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
