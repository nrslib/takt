/**
 * Tests for previewPrompts
 */

import { describe, it, expect, vi } from 'vitest';

const loadPieceByIdentifierMock = vi.fn();
const errorMock = vi.fn();

vi.mock('../infra/config/index.js', () => ({
  loadPieceByIdentifier: loadPieceByIdentifierMock,
  resolvePieceConfigValue: vi.fn(),
}));

vi.mock('../core/piece/instruction/InstructionBuilder.js', () => ({
  InstructionBuilder: vi.fn(),
}));

vi.mock('../core/piece/instruction/ReportInstructionBuilder.js', () => ({
  ReportInstructionBuilder: vi.fn(),
}));

vi.mock('../core/piece/instruction/StatusJudgmentBuilder.js', () => ({
  StatusJudgmentBuilder: vi.fn(),
}));

vi.mock('../core/piece/index.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
}));

vi.mock('../shared/ui/index.js', () => ({
  header: vi.fn(),
  info: vi.fn(),
  error: errorMock,
  blankLine: vi.fn(),
}));

const { previewPrompts } = await import('../features/prompt/preview.js');

describe('previewPrompts', () => {
  it('should call error() and return when piece is not found', async () => {
    loadPieceByIdentifierMock.mockReturnValue(undefined);

    await previewPrompts('/cwd', 'nonexistent-piece');

    expect(errorMock).toHaveBeenCalledWith(expect.stringContaining('nonexistent-piece'));
  });
});
