import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  mockDebug,
  mockConfirm,
  mockGetLabel,
  mockSelectWorkflow,
  mockIsWorkflowPath,
  mockLoadAllStandaloneWorkflowsWithSources,
  mockWarn,
} = vi.hoisted(() => ({
  mockDebug: vi.fn(),
  mockConfirm: vi.fn(),
  mockGetLabel: vi.fn((_key: string, _lang?: string, vars?: Record<string, string>) => `Use previous workflow "${vars?.workflow ?? ''}"?`),
  mockSelectWorkflow: vi.fn(),
  mockIsWorkflowPath: vi.fn(() => false),
  mockLoadAllStandaloneWorkflowsWithSources: vi.fn(() => new Map<string, unknown>([['default', {}], ['selected-workflow', {}]])),
  mockWarn: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    debug: (...args: unknown[]) => mockDebug(...args),
    info: vi.fn(),
    error: vi.fn(),
    enter: vi.fn(),
    exit: vi.fn(),
  }),
}));

vi.mock('../shared/prompt/index.js', () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: (...args: unknown[]) => mockGetLabel(...args),
}));

vi.mock('../shared/ui/index.js', () => ({
  warn: (...args: unknown[]) => mockWarn(...args),
}));

vi.mock('../features/workflowSelection/index.js', () => ({
  selectWorkflow: (...args: unknown[]) => mockSelectWorkflow(...args),
}));

vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isWorkflowPath: (...args: unknown[]) => mockIsWorkflowPath(...args),
  loadAllStandaloneWorkflowsWithSources: (...args: unknown[]) => mockLoadAllStandaloneWorkflowsWithSources(...args),
}));

import { hasDeprecatedProviderConfig, selectWorkflowWithOptionalReuse } from '../features/tasks/list/requeueHelpers.js';

describe('hasDeprecatedProviderConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('YAML parse エラーを debug 記録しつつ有効な候補で判定を続行する', () => {
    const orderContent = [
      '```yaml',
      'steps: [',
      '```',
      '',
      '```yaml',
      'steps:',
      '  - name: review',
      '    provider_options:',
      '      codex:',
      '        network_access: true',
      '```',
    ].join('\n');

    expect(hasDeprecatedProviderConfig(orderContent)).toBe(true);
    expect(mockDebug).toHaveBeenCalledTimes(1);
    expect(mockDebug).toHaveBeenCalledWith(
      'Failed to parse YAML candidate for deprecated provider config detection',
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  it('provider block 新記法のみの workflow config は deprecated と判定しない', () => {
    const orderContent = [
      'steps:',
      '  - name: review',
      '    provider:',
      '      type: codex',
      '      model: gpt-5.3',
      '      network_access: true',
    ].join('\n');

    expect(hasDeprecatedProviderConfig(orderContent)).toBe(false);
  });

  it('provider object と同階層 model の旧記法を deprecated と判定する', () => {
    const orderContent = [
      'steps:',
      '  - name: review',
      '    provider:',
      '      type: codex',
      '      network_access: true',
      '    model: gpt-5.3',
    ].join('\n');

    expect(hasDeprecatedProviderConfig(orderContent)).toBe(true);
  });

  it('循環参照を含む YAML でもスタックオーバーフローせず判定できる', () => {
    const orderContent = [
      'steps:',
      '  - &step',
      '    name: review',
      '    provider:',
      '      type: codex',
      '      model: gpt-5.3',
      '      network_access: true',
      '    self: *step',
    ].join('\n');

    expect(hasDeprecatedProviderConfig(orderContent)).toBe(false);
  });
});

describe('selectWorkflowWithOptionalReuse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsWorkflowPath.mockReturnValue(false);
    mockLoadAllStandaloneWorkflowsWithSources.mockReturnValue(new Map<string, unknown>([['default', {}], ['selected-workflow', {}]]));
    mockSelectWorkflow.mockResolvedValue('selected-workflow');
  });

  it('内部ヘルパーを公開 API に露出しない', async () => {
    const requeueHelpersModule = await import('../features/tasks/list/requeueHelpers.js');

    expect(Object.prototype.hasOwnProperty.call(requeueHelpersModule, 'resolveReusableWorkflowName')).toBe(false);
  });

  it('前回 workflow 再利用を確認して Yes ならそのまま返す', async () => {
    mockConfirm.mockResolvedValue(true);

    const selected = await selectWorkflowWithOptionalReuse('/project', 'default', 'en');

    expect(selected).toBe('default');
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockSelectWorkflow).not.toHaveBeenCalled();
  });

  it('前回 workflow 再利用を拒否した場合は workflow 選択にフォールバックする', async () => {
    mockConfirm.mockResolvedValue(false);

    const selected = await selectWorkflowWithOptionalReuse('/project', 'default', 'en');

    expect(selected).toBe('selected-workflow');
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockSelectWorkflow).toHaveBeenCalledWith('/project');
  });

  it('未登録の前回 workflow 名は確認せず拒否して workflow 選択にフォールバックする', async () => {
    mockLoadAllStandaloneWorkflowsWithSources.mockReturnValue(new Map<string, unknown>([['default', {}]]));

    const selected = await selectWorkflowWithOptionalReuse('/project', 'tampered-workflow', 'en');

    expect(selected).toBe('selected-workflow');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockSelectWorkflow).toHaveBeenCalledWith('/project');
  });

  it('再利用候補の解決で warning callback を UI warn に配線する', async () => {
    mockLoadAllStandaloneWorkflowsWithSources.mockImplementation(
      (_projectDir: string, options?: { onWarning?: (message: string) => void }) => {
        options?.onWarning?.('Workflow "broken" failed to load');
        return new Map<string, unknown>([['selected-workflow', {}]]);
      },
    );
    mockConfirm.mockResolvedValue(false);

    await selectWorkflowWithOptionalReuse('/project', 'selected-workflow', 'en');

    expect(mockLoadAllStandaloneWorkflowsWithSources).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ onWarning: expect.any(Function) }),
    );
    expect(mockWarn).toHaveBeenCalledWith('Workflow "broken" failed to load');
  });
});
