import { describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig, WorkflowStep } from '../core/models/types.js';
import { buildWorkflowPromptTree, locateWorkflowPromptStep, renderWorkflowPromptTree } from '../core/workflow/workflow-prompt-context.js';
import { makeStep, makeWorkflowResumePointEntry } from './test-helpers.js';

function workflow(name: string, steps: WorkflowStep[], description?: string): WorkflowConfig {
  return { name, steps, description, maxSteps: 20, initialStep: steps[0]!.name };
}

const expectedTree = `- root（ワークフロー）: 全体の役目
  - review: 並列レビュー
    - direct
    - nested: 子を呼ぶ
      - shared（ワークフロー）
        - dynamic
          - fixed: 常に実行
          - optional（実行時に選ばれたときだけ動く）: 選択された場合
  - again
    - shared（ワークフロー）
      - dynamic
        - fixed: 常に実行
        - optional（実行時に選ばれたときだけ動く）: 選択された場合`;

function fixture() {
  const child = workflow('shared', [makeStep({ name: 'dynamic', parallel: {
    kind: 'dynamic', selection: { mode: 'replace' },
    fixed: [{ name: 'fixed', instruction: '', personaDisplayName: 'fixed', description: '常に実行' }],
    pool: [{ name: 'optional', instruction: '', personaDisplayName: 'optional', description: '選択された場合' }],
  } })]);
  const root = workflow('root', [
    makeStep({ name: 'review', description: '並列レビュー', parallel: [
      makeStep({ name: 'direct' }),
      { name: 'nested', kind: 'workflow_call', instruction: '', personaDisplayName: 'call', call: 'shared', description: '子を呼ぶ', rules: [] },
    ] }),
    { name: 'again', kind: 'workflow_call', instruction: '', personaDisplayName: 'call', call: 'shared', rules: [] },
  ], '全体の役目');
  const resolver = vi.fn(() => child);
  return { root, resolver, tree: buildWorkflowPromptTree(root, resolver, '/project', '/work') };
}

describe('workflow prompt definition tree', () => {
  it('renders static and dynamic parallel definitions, descriptions, and each occurrence of a shared workflow', () => {
    const { tree, resolver } = fixture();
    const rendered = renderWorkflowPromptTree(tree, [['steps', 0]], 'ja');
    expect(rendered).toBe(expectedTree.replace('review: 並列レビュー', 'review: 並列レビュー ← 現在'));
    expect(rendered.match(/← 現在/g)).toHaveLength(1);
    expect(resolver.mock.calls).toHaveLength(2);
  });

  it('marks the parallel substep rather than its parent', () => {
    const { tree } = fixture();
    const location = locateWorkflowPromptStep(tree, [], ['steps', 0, 'parallel', 0]);
    expect(location.route).toEqual([['steps', 0, 'parallel', 0]]);
    expect(location.parallelParent).toBe('review');
    const rendered = renderWorkflowPromptTree(tree, location.route, 'ja');
    expect(rendered).toBe(expectedTree.replace('    - direct', '    - direct ← 現在'));
    expect(rendered.match(/← 現在/g)).toHaveLength(1);
  });

  it.each(['fixed', 'optional'] as const)('resolves the call inside a parallel parent and marks its dynamic %s substep', (name) => {
    const { tree } = fixture();
    const prefix = [
      makeWorkflowResumePointEntry({ workflow: 'root', workflow_ref: 'root', step: 'review', kind: 'parallel' }),
      makeWorkflowResumePointEntry({ workflow: 'root', workflow_ref: 'root', step: 'nested', kind: 'workflow_call' }),
    ];
    const location = locateWorkflowPromptStep(tree, prefix, ['steps', 0, 'parallel', name === 'fixed' ? 'fixed' : 'pool', 0]);
    expect(location.route).toEqual([['steps', 0, 'parallel', 1], ['steps', 0, 'parallel', name === 'fixed' ? 'fixed' : 'pool', 0]]);
    const line = name === 'fixed' ? '          - fixed: 常に実行' : '          - optional（実行時に選ばれたときだけ動く）: 選択された場合';
    const rendered = renderWorkflowPromptTree(tree, location.route, 'ja');
    expect(rendered).toBe(expectedTree.replace(line, `${line} ← 現在`));
    expect(rendered.match(/← 現在/g)).toHaveLength(1);
  });

  it('marks only the second call site of the same workflow', () => {
    const { tree } = fixture();
    const prefix = [makeWorkflowResumePointEntry({ workflow: 'root', workflow_ref: 'root', step: 'again', kind: 'workflow_call' })];
    const location = locateWorkflowPromptStep(tree, prefix, ['steps', 0, 'parallel', 'fixed', 0]);
    const rendered = renderWorkflowPromptTree(tree, location.route, 'ja');
    expect(rendered).toBe(`- root（ワークフロー）: 全体の役目
  - review: 並列レビュー
    - direct
    - nested: 子を呼ぶ
      - shared（ワークフロー）
        - dynamic
          - fixed: 常に実行
          - optional（実行時に選ばれたときだけ動く）: 選択された場合
  - again
    - shared（ワークフロー）
      - dynamic
        - fixed: 常に実行 ← 現在
        - optional（実行時に選ばれたときだけ動く）: 選択された場合`);
    expect(rendered.match(/← 現在/g)).toHaveLength(1);
  });

  it('uses the active parallel scope when a top-level step has the same name', () => {
    const root = workflow('root', [makeStep({ name: 'same' }), makeStep({ name: 'parallel', parallel: [makeStep({ name: 'same' })] })]);
    const tree = buildWorkflowPromptTree(root, undefined, '/project', '/work');
    expect(renderWorkflowPromptTree(tree, locateWorkflowPromptStep(tree, [], ['steps', 1, 'parallel', 0]).route, 'ja')).toBe(`- root（ワークフロー）
  - same
  - parallel
    - same ← 現在`);
  });

  it('distinguishes same-name parallel parents and children by their complete paths', () => {
    const root = workflow('root', [makeStep({ name: 'same', parallel: [makeStep({ name: 'same' })] })]);
    const tree = buildWorkflowPromptTree(root, undefined, '/project', '/work');
    const parent = locateWorkflowPromptStep(tree, [], ['steps', 0]);
    const child = locateWorkflowPromptStep(tree, [], ['steps', 0, 'parallel', 0]);
    expect(parent.parallelParent).toBeUndefined();
    expect(child.parallelParent).toBe('same');
    expect(renderWorkflowPromptTree(tree, parent.route, 'ja')).toBe(`- root（ワークフロー）
  - same ← 現在
    - same`);
    expect(renderWorkflowPromptTree(tree, child.route, 'ja')).toBe(`- root（ワークフロー）
  - same
    - same ← 現在`);
  });

  it('retains definition lines across phase renders without resolving calls again', () => {
    const { root, tree, resolver } = fixture();
    root.description = '後から変わった説明';
    expect(renderWorkflowPromptTree(tree, [['steps', 0]], 'ja')).toBe(expectedTree.replace('review: 並列レビュー', 'review: 並列レビュー ← 現在'));
    expect(renderWorkflowPromptTree(tree, [['steps', 1]], 'ja')).toBe(expectedTree.replace('  - again', '  - again ← 現在'));
    expect(resolver.mock.calls).toHaveLength(2);
  });

  it.each(['missing resolver', 'missing target', 'resolver error'] as const)('keeps unresolved calls as leaves without changing execution errors (%s)', (failure) => {
    const root = workflow('root', [{ name: 'delegate', kind: 'workflow_call', instruction: '', personaDisplayName: 'call', call: 'child', rules: [] }]);
    const resolver = failure === 'missing resolver' ? undefined : vi.fn(() => {
      if (failure === 'resolver error') throw new Error('resolution failed');
      return null;
    });
    const tree = buildWorkflowPromptTree(root, resolver, '/project', '/work');
    const location = locateWorkflowPromptStep(tree, [], ['steps', 0]);
    expect(renderWorkflowPromptTree(tree, location.route, 'en')).toBe('- root (workflow)\n  - delegate ← current');
  });

  it('stops expanding an active workflow reference even when the resolver returns fresh objects', () => {
    const call: WorkflowStep = { name: 'delegate', kind: 'workflow_call', instruction: '', personaDisplayName: 'call', call: 'root', rules: [] };
    const resolver = vi.fn(() => workflow('root', [structuredClone(call)]));
    const tree = buildWorkflowPromptTree(workflow('root', [call]), resolver, '/project', '/work');
    expect(renderWorkflowPromptTree(tree, [['steps', 0]], 'en')).toBe('- root (workflow)\n  - delegate ← current');
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('rejects a definition that makes the current marker ambiguous', () => {
    const tree = buildWorkflowPromptTree(workflow('root', [makeStep({ description: '← 現在' })]), undefined, '/project', '/work');
    expect(() => renderWorkflowPromptTree(tree, [['steps', 0]], 'ja')).toThrow(/exactly one/);
  });

  it('fails when the current route does not identify exactly one row', () => {
    expect(() => renderWorkflowPromptTree(fixture().tree, [['steps', 99]], 'ja')).toThrow(/exactly one/);
  });
});
