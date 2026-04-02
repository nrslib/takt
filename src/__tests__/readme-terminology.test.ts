import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readDoc(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('README public terminology', () => {
  it('uses workflow labels in the English README public sections', () => {
    const readme = readDoc('../../README.md');

    expect(readme).toContain('## Recommended Workflows');
    expect(readme).toContain('| Workflow | Use Case |');
    expect(readme).toContain('[Workflow Guide](./docs/pieces.md)');
    expect(readme).toContain('all workflows and personas');
    expect(readme).toContain('parallel steps');
    expect(readme).toContain('Copy builtin workflow to ~/.takt/workflows/ and edit');
    expect(readme).toContain('Workflow files live in `workflows/` as the official directory name.');
    expect(readme).toContain('.takt/workflows/` → `.takt/pieces/` → `~/.takt/workflows/` → `~/.takt/pieces/` → builtins');
    expect(readme).not.toContain('## Recommended Pieces');
    expect(readme).not.toContain('| Piece | Use Case |');
    expect(readme).not.toContain('all pieces and personas');
    expect(readme).not.toContain('parallel movements');
  });

  it('uses workflow labels in the Japanese README public sections', () => {
    const readmeJa = readDoc('../../docs/README.ja.md');

    expect(readmeJa).toContain('## おすすめワークフロー');
    expect(readmeJa).toContain('| Workflow | 用途 |');
    expect(readmeJa).toContain('[Workflow Guide](./pieces.md)');
    expect(readmeJa).toContain('全ワークフロー・ペルソナの一覧');
    expect(readmeJa).toContain('並列 step');
    expect(readmeJa).toContain('ビルトイン workflow を ~/.takt/workflows/ にコピーして編集できます');
    expect(readmeJa).toContain('workflow ファイルの正式ディレクトリ名は `workflows/` です。');
    expect(readmeJa).toContain('.takt/workflows/` → `.takt/pieces/` → `~/.takt/workflows/` → `~/.takt/pieces/` → builtin');
    expect(readmeJa).not.toContain('## おすすめ workflow');
    expect(readmeJa).not.toContain('| Piece | 用途 |');
    expect(readmeJa).not.toContain('全ピース・ペルソナの一覧');
    expect(readmeJa).not.toContain('並列 movement');
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
    expect(cliRef).toContain('.takt/workflows/` → `.takt/pieces/` → `~/.takt/workflows/` → `~/.takt/pieces/` → builtins');
    expect(cliRef).not.toContain('Select piece');
    expect(cliRef).not.toContain('Preview assembled prompts for each movement');
    expect(cliRef).not.toContain('takt prompt [piece]');

    expect(cliRefJa).toContain('workflow を選択');
    expect(cliRefJa).toContain('| `-w, --workflow <name or path>` | workflow 名または workflow YAML ファイルのパス |');
    expect(cliRefJa).toContain('ビルトインの workflow/persona をローカルディレクトリにコピーしてカスタマイズします。');
    expect(cliRefJa).toContain('workflow 選択やファセット解決で利用可能になります。');
    expect(cliRefJa).toContain('takt prompt [workflow]');
    expect(cliRefJa).toContain('正式オプションは `--workflow` です。');
    expect(cliRefJa).toContain('.takt/workflows/` → `.takt/pieces/` → `~/.takt/workflows/` → `~/.takt/pieces/` → builtin');
    expect(cliRefJa).not.toContain('アクティブな piece');
    expect(cliRefJa).not.toContain('takt prompt [piece]');
  });

  it('uses workflow labels in the workflow guide public sections', () => {
    const workflowGuide = readDoc('../../docs/pieces.md');

    expect(workflowGuide).toContain('# Workflow Guide');
    expect(workflowGuide).toContain('This guide explains how to create and customize TAKT workflows.');
    expect(workflowGuide).toContain('## Workflow Basics');
    expect(workflowGuide).toContain('`~/.takt/workflows/`');
    expect(workflowGuide).toContain('Use `takt eject <workflow>` to copy a builtin to `~/.takt/workflows/` for customization');
    expect(workflowGuide).toContain('## Workflow Schema');
    expect(workflowGuide).toContain('initial_step: first-step');
    expect(workflowGuide).toContain('steps:');
    expect(workflowGuide).toContain('Legacy YAML keys remain accepted for compatibility');
    expect(workflowGuide).toContain('## Parallel Steps');
    expect(workflowGuide).toContain('## Step Options');
    expect(workflowGuide).not.toContain('# Piece Guide');
    expect(workflowGuide).not.toContain('## Piece Basics');
    expect(workflowGuide).not.toContain('## Piece Schema');
    expect(workflowGuide).not.toContain('## Parallel Movements');
    expect(workflowGuide).not.toContain('## Movement Options');
  });

  it('uses workflow labels in the builtin catalog public sections', () => {
    const builtinCatalog = readDoc('../../docs/builtin-catalog.md');
    const builtinCatalogJa = readDoc('../../docs/builtin-catalog.ja.md');

    expect(builtinCatalog).toContain('all builtin workflows and personas');
    expect(builtinCatalog).toContain('## Recommended Workflows');
    expect(builtinCatalog).toContain('| Workflow | Recommended Use |');
    expect(builtinCatalog).toContain('Run `takt` to choose a workflow interactively.');
    expect(builtinCatalog).not.toContain('## Recommended Pieces');
    expect(builtinCatalog).not.toContain('| Piece | Recommended Use |');

    expect(builtinCatalogJa).toContain('すべてのビルトイン workflow と persona');
    expect(builtinCatalogJa).toContain('## おすすめワークフロー');
    expect(builtinCatalogJa).toContain('| Workflow | 推奨用途 |');
    expect(builtinCatalogJa).toContain('`takt` を実行すると workflow をインタラクティブに選択できます。');
    expect(builtinCatalogJa).not.toContain('## おすすめ Piece');
    expect(builtinCatalogJa).not.toContain('全ビルトイン Piece 一覧');
  });

  it('uses workflow labels in agent and faceted prompting guides', () => {
    const agentGuide = readDoc('../../docs/agents.md');
    const facetedPrompting = readDoc('../../docs/faceted-prompting.md');
    const facetedPromptingJa = readDoc('../../docs/faceted-prompting.ja.md');

    expect(agentGuide).toContain('workflow YAML');
    expect(agentGuide).toContain('steps:');
    expect(agentGuide).not.toContain('### Specifying Personas in Pieces');
    expect(agentGuide).not.toContain('movements:');

    expect(facetedPrompting).toContain('workflow definitions');
    expect(facetedPrompting).toContain('initial_step: plan');
    expect(facetedPrompting).toContain('steps:');
    expect(facetedPrompting).toContain('Legacy `movements` / `initial_movement` keys remain accepted');
    expect(facetedPrompting).not.toContain('initial_movement: plan');

    expect(facetedPromptingJa).toContain('workflow 定義');
    expect(facetedPromptingJa).toContain('initial_step: plan');
    expect(facetedPromptingJa).toContain('steps:');
    expect(facetedPromptingJa).toContain('`movements` / `initial_movement` も引き続き受理');
    expect(facetedPromptingJa).not.toContain('movements:\n');
  });

  it('uses workflow labels in repertoire and e2e docs where users invoke workflows', () => {
    const repertoire = readDoc('../../docs/repertoire.md');
    const repertoireJa = readDoc('../../docs/repertoire.ja.md');
    const e2eDoc = readDoc('../../docs/testing/e2e.md');

    expect(repertoire).toContain('TAKT workflows and facets');
    expect(repertoire).toContain('workflow selection UI');
    expect(repertoire).toContain('takt --workflow @nrslib/takt-fullstack/expert');
    expect(repertoire).toContain('workflow YAML');
    expect(repertoire).not.toContain('takt --piece @nrslib/takt-fullstack/expert');

    expect(repertoireJa).toContain('TAKT の workflow やファセット');
    expect(repertoireJa).toContain('workflow 選択 UI');
    expect(repertoireJa).toContain('takt --workflow @nrslib/takt-fullstack/expert');
    expect(repertoireJa).toContain('workflow YAML');
    expect(repertoireJa).not.toContain('takt --piece @nrslib/takt-fullstack/expert');

    expect(e2eDoc).toContain('--workflow e2e/fixtures/pieces/simple.yaml');
    expect(e2eDoc).toContain('`workflow` は `e2e/fixtures/pieces/simple.yaml` を指定');
    expect(e2eDoc).toContain('Workflow completed');
    expect(e2eDoc).toContain('=== Running Workflow:');
    expect(e2eDoc).not.toContain('--piece e2e/fixtures/pieces/simple.yaml');
    expect(e2eDoc).not.toContain('Piece completed');
    expect(e2eDoc).not.toContain('=== Running Piece:');
  });

  it('does not document unsupported workflow project config keys', () => {
    const configDoc = readDoc('../../docs/configuration.md');
    const configDocJa = readDoc('../../docs/configuration.ja.md');

    expect(configDoc).not.toContain('workflow: default             # Current workflow for this project');
    expect(configDoc).not.toContain('| `workflow` | string | `"default"` | Current workflow name for this project |');
    expect(configDoc).toContain('`builtins/{lang}/workflow-categories.yaml` - Default builtin categories');
    expect(configDoc).not.toContain('`builtins/{lang}/piece-categories.yaml` - Default builtin categories');
    expect(configDocJa).not.toContain('workflow: default             # このプロジェクトの現在の workflow');
    expect(configDocJa).not.toContain('| `workflow` | string | `"default"` | このプロジェクトの現在の workflow 名 |');
    expect(configDocJa).toContain('`builtins/{lang}/workflow-categories.yaml` - デフォルトのビルトインカテゴリ');
    expect(configDocJa).not.toContain('`builtins/{lang}/piece-categories.yaml` - デフォルトのビルトインカテゴリ');
  });

  it('uses step permission terminology in provider sandbox docs', () => {
    const providerSandbox = readDoc('../../docs/provider-sandbox.md');

    expect(providerSandbox).toContain('step_permission_overrides');
    expect(providerSandbox).toContain('Only the implement step gets full access');
    expect(providerSandbox).toContain('Use for review steps where the agent only needs to analyze code.');
    expect(providerSandbox).toContain('recommended default for implementation steps.');
    expect(providerSandbox).toContain('If your workflow involves implementation');
    expect(providerSandbox).toContain('reviewed by subsequent steps.');
    expect(providerSandbox).not.toContain('movement_permission_overrides');
    expect(providerSandbox).not.toContain('Only the implement movement gets full access');
    expect(providerSandbox).not.toContain('review movements');
    expect(providerSandbox).not.toContain('implementation movements');
    expect(providerSandbox).not.toContain('If your piece involves implementation');
    expect(providerSandbox).not.toContain('subsequent movements');
  });
});
