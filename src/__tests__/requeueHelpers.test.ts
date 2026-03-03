import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockDebug } = vi.hoisted(() => ({
  mockDebug: vi.fn(),
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

import { hasDeprecatedProviderConfig } from '../features/tasks/list/requeueHelpers.js';

describe('hasDeprecatedProviderConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('YAML parse エラーを debug 記録しつつ有効な候補で判定を続行する', () => {
    const orderContent = [
      '```yaml',
      'movements: [',
      '```',
      '',
      '```yaml',
      'movements:',
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

  it('provider block 新記法のみの piece config は deprecated と判定しない', () => {
    const orderContent = [
      'movements:',
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
      'movements:',
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
      'movements:',
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
