import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const removedTerms = {
  oldWorkflow: ['p', 'i', 'e', 'c', 'e'].join(''),
  oldStep: ['m', 'o', 'v', 'e', 'm', 'e', 'n', 't'].join(''),
  oldWorkflowTitle: ['P', 'i', 'e', 'c', 'e'].join(''),
  oldStepTitle: ['M', 'o', 'v', 'e', 'm', 'e', 'n', 't'].join(''),
};
const removedWorkflowPluralTitle = `${removedTerms.oldWorkflowTitle}s`;
const removedWorkflowPlural = `${removedTerms.oldWorkflow}s`;
const removedStepPluralTitle = `${removedTerms.oldStepTitle}s`;
const nextLegacyStepToken = `next${removedTerms.oldStepTitle}`;
const failureLegacyStepToken = `failure${removedTerms.oldStepTitle}`;
const workflowLegacyStepToken = `Workflow${removedTerms.oldStepTitle}`;
const parallelSubStepSchemaToken = `ParallelSub${removedTerms.oldStepTitle}RawSchema`;
const addSubStepToken = `addSub${removedTerms.oldStepTitle}`;
const selectLegacyWorkflowToken = `select${removedTerms.oldWorkflowTitle}FromCategoryTree`;

function readDoc(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function readTestAsset(relativePath: string): string {
  const baseDir = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(baseDir, relativePath), 'utf8');
}

describe('README public terminology', () => {
  it('uses workflow labels in the English README public sections', () => {
    const readme = readDoc('../../README.md');

    expect(readme).toContain('## Recommended Workflows');
    expect(readme).toContain('| Workflow | Use Case |');
    expect(readme).toContain('[Workflow Guide](./docs/workflows.md)');
    expect(readme).toContain('all workflows and personas');
    expect(readme).toContain('parallel steps');
    expect(readme).toContain('Copy builtin workflow to ~/.takt/workflows/ and edit');
    expect(readme).toContain('Workflow files live in `workflows/` as the official directory name.');
    expect(readme).toContain('.takt/workflows/` → `~/.takt/workflows/` → builtins');
    expect(readme).not.toContain(`## Recommended ${removedWorkflowPluralTitle}`);
    expect(readme).not.toContain(`| ${removedTerms.oldWorkflowTitle} | Use Case |`);
    expect(readme).not.toContain(`all ${removedWorkflowPlural} and personas`);
    expect(readme).not.toContain(`parallel ${removedTerms.oldStep}s`);
  });

  it('uses workflow labels in the Japanese README public sections', () => {
    const readmeJa = readDoc('../../docs/README.ja.md');

    expect(readmeJa).toContain('## おすすめワークフロー');
    expect(readmeJa).toContain('| Workflow | 用途 |');
    expect(readmeJa).toContain('[Workflow Guide](./workflows.md)');
    expect(readmeJa).toContain('全ワークフロー・ペルソナの一覧');
    expect(readmeJa).toContain('並列 step');
    expect(readmeJa).toContain('ビルトイン workflow を ~/.takt/workflows/ にコピーして編集できます');
    expect(readmeJa).toContain('workflow ファイルの正式ディレクトリ名は `workflows/` です。');
    expect(readmeJa).toContain('.takt/workflows/` → `~/.takt/workflows/` → builtin');
    expect(readmeJa).not.toContain('## おすすめ workflow');
    expect(readmeJa).not.toContain(`| ${removedTerms.oldWorkflowTitle} | 用途 |`);
    expect(readmeJa).not.toContain('全ピース・ペルソナの一覧');
    expect(readmeJa).not.toContain(`並列 ${removedTerms.oldStep}`);
  });

  it('uses workflow labels in the CLI reference public sections', () => {
    const cliRef = readDoc('../../docs/cli-reference.md');
    const cliRefJa = readDoc('../../docs/cli-reference.ja.md');

    expect(cliRef).toContain('Select workflow');
    expect(cliRef).toContain('| `-w, --workflow <name or path>` | Workflow name or path to workflow YAML file |');
    expect(cliRef).toContain('Copy builtin workflows/personas');
    expect(cliRef).toContain('Preview assembled prompts for each step and phase.');
    expect(cliRef).toContain('takt prompt [workflow]');
    expect(cliRef).toContain('`--workflow` is the canonical option.');
    expect(cliRef).toContain('.takt/workflows/` → `~/.takt/workflows/` → builtins');
    expect(cliRef).not.toContain(`Select ${removedTerms.oldWorkflow}`);
    expect(cliRef).not.toContain(`--${removedTerms.oldWorkflow} <name or path>`);
    expect(cliRef).not.toContain(`Preview assembled prompts for each ${removedTerms.oldStep}`);
    expect(cliRef).not.toContain(`takt prompt [${removedTerms.oldWorkflow}]`);

    expect(cliRefJa).toContain('workflow を選択');
    expect(cliRefJa).toContain('| `-w, --workflow <name or path>` | workflow 名または workflow YAML ファイルのパス |');
    expect(cliRefJa).toContain('ビルトインの workflow/persona をローカルディレクトリにコピーしてカスタマイズします。');
    expect(cliRefJa).toContain('workflow 選択やファセット解決で利用可能になります。');
    expect(cliRefJa).toContain('takt prompt [workflow]');
    expect(cliRefJa).toContain('正式オプションは `--workflow` です。');
    expect(cliRefJa).toContain('.takt/workflows/` → `~/.takt/workflows/` → builtin');
    expect(cliRefJa).not.toContain(`アクティブな ${removedTerms.oldWorkflow}`);
    expect(cliRefJa).not.toContain(`--${removedTerms.oldWorkflow} <name or path>`);
    expect(cliRefJa).not.toContain(`takt prompt [${removedTerms.oldWorkflow}]`);
  });

  it('uses workflow labels in the workflow guide public sections', () => {
    const workflowGuide = readDoc('../../docs/workflows.md');

    expect(workflowGuide).toContain('# Workflow Guide');
    expect(workflowGuide).toContain('This guide explains how to create and customize TAKT workflows.');
    expect(workflowGuide).toContain('## Workflow Basics');
    expect(workflowGuide).toContain('`~/.takt/workflows/`');
    expect(workflowGuide).toContain('Use `takt eject <workflow>` to copy a builtin to `~/.takt/workflows/` for customization');
    expect(workflowGuide).toContain('## Workflow Schema');
    expect(workflowGuide).toContain('initial_step: first-step');
    expect(workflowGuide).toContain('steps:');
    expect(workflowGuide).toContain('workflow_categories');
    expect(workflowGuide).toContain('provider_options.claude.allowed_tools');
    expect(workflowGuide).toContain('## Parallel Steps');
    expect(workflowGuide).toContain('## Step Options');
    expect(workflowGuide).not.toContain('| `allowed_tools` | - | List of tools the agent can use');
    expect(workflowGuide).not.toContain('instruction_template:');
    expect(workflowGuide).not.toContain(`# ${removedTerms.oldWorkflowTitle} Guide`);
    expect(workflowGuide).not.toContain(`## ${removedTerms.oldWorkflowTitle} Basics`);
    expect(workflowGuide).not.toContain(`## ${removedTerms.oldWorkflowTitle} Schema`);
    expect(workflowGuide).not.toContain(`## Parallel ${removedStepPluralTitle}`);
    expect(workflowGuide).not.toContain(`## ${removedTerms.oldStepTitle} Options`);
  });

  it('documents Claude tool allowlists with provider_options in the workflow guide', () => {
    const workflowGuide = readDoc('../../docs/workflows.md');

    expect(workflowGuide).toContain('provider_options:');
    expect(workflowGuide).toContain('provider_options.claude.allowed_tools');
    expect(workflowGuide).not.toContain('\n    allowed_tools: [Read, Glob, Grep, Edit, Write, Bash, WebSearch, WebFetch]');
    expect(workflowGuide).not.toContain('| `allowed_tools` | - | List of tools the agent can use');
  });

  it('uses workflow labels in the builtin catalog public sections', () => {
    const builtinCatalog = readDoc('../../docs/builtin-catalog.md');
    const builtinCatalogJa = readDoc('../../docs/builtin-catalog.ja.md');

    expect(builtinCatalog).toContain('all builtin workflows and personas');
    expect(builtinCatalog).toContain('## Recommended Workflows');
    expect(builtinCatalog).toContain('| Workflow | Recommended Use |');
    expect(builtinCatalog).toContain('Run `takt` to choose a workflow interactively.');
    expect(builtinCatalog).not.toContain(`## Recommended ${removedWorkflowPluralTitle}`);
    expect(builtinCatalog).not.toContain(`| ${removedTerms.oldWorkflowTitle} | Recommended Use |`);

    expect(builtinCatalogJa).toContain('すべてのビルトイン workflow と persona');
    expect(builtinCatalogJa).toContain('## おすすめワークフロー');
    expect(builtinCatalogJa).toContain('| Workflow | 推奨用途 |');
    expect(builtinCatalogJa).toContain('`takt` を実行すると workflow をインタラクティブに選択できます。');
    expect(builtinCatalogJa).not.toContain(`## おすすめ ${removedTerms.oldWorkflowTitle}`);
    expect(builtinCatalogJa).not.toContain(`全ビルトイン ${removedTerms.oldWorkflowTitle} 一覧`);
  });

  it('uses workflow labels in agent and faceted prompting guides', () => {
    const agentGuide = readDoc('../../docs/agents.md');
    const facetedPrompting = readDoc('../../docs/faceted-prompting.md');
    const facetedPromptingJa = readDoc('../../docs/faceted-prompting.ja.md');

    expect(agentGuide).toContain('workflow YAML');
    expect(agentGuide).toContain('steps:');
    expect(agentGuide).not.toContain(`### Specifying Personas in ${removedWorkflowPluralTitle}`);
    expect(agentGuide).not.toContain(`${removedTerms.oldWorkflow} YAML`);

    expect(facetedPrompting).toContain('workflow definitions');
    expect(facetedPrompting).toContain('initial_step: plan');
    expect(facetedPrompting).toContain('steps:');
    expect(facetedPrompting).toContain('max_steps: 10');
    expect(facetedPrompting).not.toContain('Legacy `steps` / `initial_movement` keys remain accepted');

    expect(facetedPromptingJa).toContain('workflow 定義');
    expect(facetedPromptingJa).toContain('initial_step: plan');
    expect(facetedPromptingJa).toContain('steps:');
    expect(facetedPromptingJa).toContain('max_steps: 10');
    expect(facetedPromptingJa).not.toContain('`steps` / `initial_movement` も引き続き受理');
  });

  it('uses workflow labels in repertoire and e2e docs where users invoke workflows', () => {
    const repertoire = readDoc('../../docs/repertoire.md');
    const repertoireJa = readDoc('../../docs/repertoire.ja.md');
    const e2eDoc = readDoc('../../docs/testing/e2e.md');

    expect(repertoire).toContain('TAKT workflows and facets');
    expect(repertoire).toContain('workflow selection UI');
    expect(repertoire).toContain('takt --workflow @nrslib/takt-fullstack/expert');
    expect(repertoire).toContain('workflow YAML');
    expect(repertoire).not.toContain(`takt --${removedTerms.oldWorkflow} @nrslib/takt-fullstack/expert`);

    expect(repertoireJa).toContain('TAKT の workflow やファセット');
    expect(repertoireJa).toContain('workflow 選択 UI');
    expect(repertoireJa).toContain('takt --workflow @nrslib/takt-fullstack/expert');
    expect(repertoireJa).toContain('workflow YAML');
    expect(repertoireJa).not.toContain(`takt --${removedTerms.oldWorkflow} @nrslib/takt-fullstack/expert`);

    expect(e2eDoc).toContain('--workflow e2e/fixtures/workflows/simple.yaml');
    expect(e2eDoc).toContain('`workflow` は `e2e/fixtures/workflows/simple.yaml` を指定');
    expect(e2eDoc).toContain('Workflow completed');
    expect(e2eDoc).toContain('=== Running Workflow:');
    expect(e2eDoc).not.toContain(`--${removedTerms.oldWorkflow} e2e/fixtures/workflows/simple.yaml`);
    expect(e2eDoc).not.toContain(`${removedTerms.oldWorkflowTitle} completed`);
    expect(e2eDoc).not.toContain(`=== Running ${removedTerms.oldWorkflowTitle}:`);
  });

  it('does not document unsupported workflow project config keys', () => {
    const configDoc = readDoc('../../docs/configuration.md');
    const configDocJa = readDoc('../../docs/configuration.ja.md');

    expect(configDoc).not.toContain('workflow: default             # Current workflow for this project');
    expect(configDoc).not.toContain('| `workflow` | string | `"default"` | Current workflow name for this project |');
    expect(configDoc).toContain(
      '`builtins/{lang}/workflow-categories.yaml` — default builtin categories (bundled with TAKT)',
    );
    expect(configDoc).not.toContain(`\`builtins/{lang}/${removedTerms.oldWorkflow}-categories.yaml\` — default builtin categories`);
    expect(configDocJa).not.toContain('workflow: default             # このプロジェクトの現在の workflow');
    expect(configDocJa).not.toContain('| `workflow` | string | `"default"` | このプロジェクトの現在の workflow 名 |');
    expect(configDocJa).toContain('`builtins/{lang}/workflow-categories.yaml` — TAKT 同梱のデフォルト');
    expect(configDocJa).not.toContain(`\`builtins/{lang}/${removedTerms.oldWorkflow}-categories.yaml\` — TAKT 同梱のデフォルト`);
  });

  it('uses step permission terminology in provider sandbox docs', () => {
    const providerSandbox = readDoc('../../docs/provider-sandbox.md');

    expect(providerSandbox).toContain('step_permission_overrides');
    expect(providerSandbox).toContain('Only the implement step gets full access');
    expect(providerSandbox).toContain('Use for review steps where the agent only needs to analyze code.');
    expect(providerSandbox).toContain('recommended default for implementation steps.');
    expect(providerSandbox).toContain('If your workflow involves implementation');
    expect(providerSandbox).toContain('reviewed by subsequent steps.');
    expect(providerSandbox).not.toContain(`Only the implement ${removedTerms.oldStep} gets full access`);
    expect(providerSandbox).not.toContain(`If your ${removedTerms.oldWorkflow} involves implementation`);
  });

  it('keeps instruction_template removed from public skill references', () => {
    const engineDoc = readDoc('../../builtins/skill-codex/references/engine.md');
    const schemaDoc = readDoc('../../builtins/skill-codex/references/yaml-schema.md');

    expect(engineDoc).not.toContain('instruction_template');
    expect(schemaDoc).toContain('`instruction`');
    expect(schemaDoc).toContain('受理されない');
  });

  it('uses workflow context terminology in builtins guidance', () => {
    const styleGuide = readDoc('../../builtins/ja/STYLE_GUIDE.md');
    const outputGuide = readDoc('../../builtins/ja/OUTPUT_CONTRACT_STYLE_GUIDE.md');
    const implementAfterTests = readDoc('../../builtins/ja/facets/instructions/implement-after-tests.md');
    const writeTestsFirst = readDoc('../../builtins/ja/facets/instructions/write-tests-first.md');
    const implementTest = readDoc('../../builtins/ja/facets/instructions/implement-test.md');
    const implementTerraform = readDoc('../../builtins/ja/facets/instructions/implement-terraform.md');
    const implementAfterTestsEn = readDoc('../../builtins/en/facets/instructions/implement-after-tests.md');
    const writeTestsFirstEn = readDoc('../../builtins/en/facets/instructions/write-tests-first.md');
    const implementTestEn = readDoc('../../builtins/en/facets/instructions/implement-test.md');
    const implementTerraformEn = readDoc('../../builtins/en/facets/instructions/implement-terraform.md');

    expect(styleGuide).toContain('[Workflow Context]');
    expect(styleGuide).not.toContain(`[${removedTerms.oldWorkflowTitle} Context]`);
    expect(outputGuide).toContain('## Workflow Context');
    expect(outputGuide).not.toContain(`## ${removedTerms.oldWorkflowTitle} Context`);
    expect(outputGuide).not.toContain('後続ムーブメント');
    expect(outputGuide).not.toContain('ピース固有のルーティング');
    expect(outputGuide).not.toContain('fix ムーブメント');
    expect(outputGuide).not.toContain('ピースの最終出力');
    expect(outputGuide).not.toContain('ピースYAML');
    expect(implementAfterTests).toContain('Workflow Context');
    expect(writeTestsFirst).toContain('Workflow Context');
    expect(implementTest).toContain('Workflow Context');
    expect(implementTerraform).toContain('Workflow Context');
    expect(implementAfterTestsEn).toContain('Workflow Context');
    expect(writeTestsFirstEn).toContain('Workflow Context');
    expect(implementTestEn).toContain('Workflow Context');
    expect(implementTerraformEn).toContain('Workflow Context');
    expect(implementAfterTestsEn).not.toContain(`${removedTerms.oldWorkflowTitle} Context`);
    expect(writeTestsFirstEn).not.toContain(`${removedTerms.oldWorkflowTitle} Context`);
    expect(implementTestEn).not.toContain(`${removedTerms.oldWorkflowTitle} Context`);
    expect(implementTerraformEn).not.toContain(`${removedTerms.oldWorkflowTitle} Context`);
  });

  it('keeps changelog terminology aligned with current workflow contracts', () => {
    const changelogJa = readDoc('../../docs/CHANGELOG.ja.md');
    const builtinJaConfig = readDoc('../../builtins/ja/config.yaml');

    expect(changelogJa).not.toContain('pieces, personas, policies, knowledge, instructions, output-contracts');
    expect(changelogJa).not.toContain('max_movement');
    expect(changelogJa).not.toContain('instruction_template フィールドを非推奨化');
    expect(changelogJa).not.toContain('後方互換あり');
    expect(changelogJa).not.toContain(`${removedTerms.oldStepTitle}Executor`);
    expect(changelogJa).not.toContain(workflowLegacyStepToken);
    expect(changelogJa).not.toContain(parallelSubStepSchemaToken);
    expect(changelogJa).not.toContain(addSubStepToken);
    expect(changelogJa).not.toContain(selectLegacyWorkflowToken);
    expect(builtinJaConfig).not.toContain('ムーブメントプレビュー数');
    expect(builtinJaConfig).not.toContain('ピース/ムーブメントで上書き可能');
    expect(builtinJaConfig).not.toContain('ビルトインピース名');
  });

  it('keeps test asset names and canonical assertions free of legacy terminology', () => {
    const workflowExecutionTest = readTestAsset('workflowExecution-debug-prompts.test.ts');
    const workflowPatternTest = readTestAsset('it-workflow-patterns.test.ts');
    const workflowLoadWarningTest = readTestAsset('workflowLoadWarning.test.ts');
    const analyticsWorkflowExecutionTest = readTestAsset('analytics-workflowExecution.test.ts');
    const engineErrorTest = readTestAsset('engine-error.test.ts');
    const taskTest = readTestAsset('task.test.ts');
    const slackWebhookTest = readTestAsset('slackWebhook.test.ts');
    const instructionBuilderTest = readTestAsset('instructionBuilder.test.ts');
    const interactiveSummaryTest = readTestAsset('interactive-summary.test.ts');
    const facetResolutionTest = readTestAsset('facet-resolution.test.ts');
    const sessionKeyTest = readTestAsset('session-key.test.ts');
    const opencodeConfigTest = readTestAsset('opencode-config.test.ts');
    const teamLeaderSchemaLoaderTest = readTestAsset('team-leader-schema-loader.test.ts');
    const worktreeExceededRequeueTest = readTestAsset('worktree-exceeded-requeue.test.ts');
    const providerBlockTest = readTestAsset('it-provider-config-block.test.ts');
    const deploySkillTest = readTestAsset('deploySkill.test.ts');
    const deploySkillCodexTest = readTestAsset('deploySkillCodex.test.ts');
    const workflowLoaderTest = readTestAsset('it-workflow-loader.test.ts');
    const engineTeamLeaderTest = readTestAsset('engine-team-leader.test.ts');
    const repertoireRemoveTest = readTestAsset('repertoire/remove.test.ts');
    const repertoirePackSummaryTest = readTestAsset('repertoire/pack-summary.test.ts');
    const removedWorkflowFixtureDir = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../e2e/fixtures',
      `${removedTerms.oldWorkflow}s`,
    );

    expect(workflowExecutionTest).not.toContain(`${removedTerms.oldWorkflow}Execution`);
    expect(workflowPatternTest).not.toContain(`it-${removedTerms.oldWorkflow}-patterns`);
    expect(workflowLoadWarningTest).not.toContain(`${removedTerms.oldWorkflow}LoadWarning`);
    expect(analyticsWorkflowExecutionTest).not.toContain(`analytics-${removedTerms.oldWorkflow}Execution`);
    expect(engineErrorTest).not.toContain(nextLegacyStepToken);
    expect(taskTest).not.toContain(failureLegacyStepToken);
    expect(slackWebhookTest).not.toContain(failureLegacyStepToken);
    expect(instructionBuilderTest).not.toContain(`my-${removedTerms.oldWorkflow}`);
    expect(interactiveSummaryTest).not.toContain(`my-${removedTerms.oldWorkflow}`);
    expect(facetResolutionTest).not.toContain(`test-${removedTerms.oldWorkflow}`);
    expect(facetResolutionTest).not.toContain(`${removedTerms.oldWorkflow}Dir`);
    expect(sessionKeyTest).not.toContain(`test-${removedTerms.oldStep}`);
    expect(opencodeConfigTest).not.toContain(`test-${removedTerms.oldStep}`);
    expect(teamLeaderSchemaLoaderTest).not.toContain(`name: '${removedTerms.oldWorkflow}'`);
    expect(teamLeaderSchemaLoaderTest).not.toContain(`${removedTerms.oldWorkflow}Dir`);
    expect(worktreeExceededRequeueTest).not.toContain(`test-${removedTerms.oldWorkflow}`);
    expect(worktreeExceededRequeueTest).not.toContain(`buildTest${removedTerms.oldWorkflowTitle}Config`);
    expect(providerBlockTest).not.toContain(`${removedTerms.oldWorkflow}Body`);
    expect(providerBlockTest).not.toContain(`${removedTerms.oldWorkflow}_config`);
    expect(deploySkillTest).not.toContain('should not create a workflows directory');
    expect(deploySkillCodexTest).not.toContain('should not create a workflows directory');
    expect(workflowLoaderTest).not.toContain(`description: ${removedTerms.oldWorkflowTitle} `);
    expect(engineTeamLeaderTest).not.toContain('ムーブメント失敗');
    expect(repertoireRemoveTest).not.toContain(` ${removedTerms.oldWorkflow}s`);
    expect(repertoirePackSummaryTest).not.toContain(` ${removedTerms.oldWorkflow}s`);
    expect(existsSync(removedWorkflowFixtureDir)).toBe(false);
  });
});
