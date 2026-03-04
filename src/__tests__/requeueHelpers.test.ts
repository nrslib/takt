import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  mockDebug,
  mockConfirm,
  mockGetLabel,
  mockSelectPiece,
  mockIsPiecePath,
  mockLoadAllPiecesWithSources,
} = vi.hoisted(() => ({
  mockDebug: vi.fn(),
  mockConfirm: vi.fn(),
  mockGetLabel: vi.fn((_key: string, _lang?: string, vars?: Record<string, string>) => `Use previous piece "${vars?.piece ?? ''}"?`),
  mockSelectPiece: vi.fn(),
  mockIsPiecePath: vi.fn(() => false),
  mockLoadAllPiecesWithSources: vi.fn(() => new Map<string, unknown>([['default', {}], ['selected-piece', {}]])),
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

vi.mock('../features/pieceSelection/index.js', () => ({
  selectPiece: (...args: unknown[]) => mockSelectPiece(...args),
}));

vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPiecePath: (...args: unknown[]) => mockIsPiecePath(...args),
  loadAllPiecesWithSources: (...args: unknown[]) => mockLoadAllPiecesWithSources(...args),
}));

import { hasDeprecatedProviderConfig, selectPieceWithOptionalReuse } from '../features/tasks/list/requeueHelpers.js';

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

describe('selectPieceWithOptionalReuse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPiecePath.mockReturnValue(false);
    mockLoadAllPiecesWithSources.mockReturnValue(new Map<string, unknown>([['default', {}], ['selected-piece', {}]]));
    mockSelectPiece.mockResolvedValue('selected-piece');
  });

  it('内部ヘルパーを公開 API に露出しない', async () => {
    const requeueHelpersModule = await import('../features/tasks/list/requeueHelpers.js');

    expect(Object.prototype.hasOwnProperty.call(requeueHelpersModule, 'resolveReusablePieceName')).toBe(false);
  });

  it('前回 piece 再利用を確認して Yes ならそのまま返す', async () => {
    mockConfirm.mockResolvedValue(true);

    const selected = await selectPieceWithOptionalReuse('/project', 'default', 'en');

    expect(selected).toBe('default');
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockSelectPiece).not.toHaveBeenCalled();
  });

  it('前回 piece 再利用を拒否した場合は piece 選択にフォールバックする', async () => {
    mockConfirm.mockResolvedValue(false);

    const selected = await selectPieceWithOptionalReuse('/project', 'default', 'en');

    expect(selected).toBe('selected-piece');
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockSelectPiece).toHaveBeenCalledWith('/project');
  });

  it('未登録の前回 piece 名は確認せず拒否して piece 選択にフォールバックする', async () => {
    mockLoadAllPiecesWithSources.mockReturnValue(new Map<string, unknown>([['default', {}]]));

    const selected = await selectPieceWithOptionalReuse('/project', 'tampered-piece', 'en');

    expect(selected).toBe('selected-piece');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockSelectPiece).toHaveBeenCalledWith('/project');
  });
});
