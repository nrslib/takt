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
    expect(readme).toContain('Copy builtin workflow to ~/.takt/pieces/ and edit');
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
    expect(readmeJa).toContain('ビルトイン workflow を ~/.takt/pieces/ にコピーして編集できます');
    expect(readmeJa).not.toContain('## おすすめ workflow');
    expect(readmeJa).not.toContain('| Piece | 用途 |');
    expect(readmeJa).not.toContain('全ピース・ペルソナの一覧');
    expect(readmeJa).not.toContain('並列 movement');
  });

  it('uses workflow labels in the CLI reference public sections', () => {
    const cliRef = readDoc('../../docs/cli-reference.md');
    const cliRefJa = readDoc('../../docs/cli-reference.ja.md');

    expect(cliRef).toContain('Select workflow');
    expect(cliRef).toContain('| `-w, --piece <name or path>` | Workflow name or path to workflow YAML file |');
    expect(cliRef).toContain('Copy builtin workflows/personas');
    expect(cliRef).toContain('Preview assembled prompts for each step and phase.');
    expect(cliRef).toContain('takt prompt [workflow]');
    expect(cliRef).not.toContain('Select piece');
    expect(cliRef).not.toContain('Preview assembled prompts for each movement');
    expect(cliRef).not.toContain('takt prompt [piece]');

    expect(cliRefJa).toContain('workflow を選択');
    expect(cliRefJa).toContain('| `-w, --piece <name or path>` | workflow 名または workflow YAML ファイルのパス |');
    expect(cliRefJa).toContain('ビルトインの workflow/persona をローカルディレクトリにコピーしてカスタマイズします。');
    expect(cliRefJa).toContain('workflow 選択やファセット解決で利用可能になります。');
    expect(cliRefJa).toContain('takt prompt [workflow]');
    expect(cliRefJa).not.toContain('アクティブな piece');
    expect(cliRefJa).not.toContain('takt prompt [piece]');
  });
});
