import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

const {
  mockLoadPieceByIdentifier,
  mockResolvePieceConfigValue,
  mockHeader,
  mockInfo,
  mockError,
  mockBlankLine,
  mockInstructionBuild,
  mockReportBuild,
  mockJudgmentBuild,
} = vi.hoisted(() => ({
  mockLoadPieceByIdentifier: vi.fn(),
  mockResolvePieceConfigValue: vi.fn(),
  mockHeader: vi.fn(),
  mockInfo: vi.fn(),
  mockError: vi.fn(),
  mockBlankLine: vi.fn(),
  mockInstructionBuild: vi.fn(() => 'phase1'),
  mockReportBuild: vi.fn(() => 'phase2'),
  mockJudgmentBuild: vi.fn(() => 'phase3'),
}));

vi.mock('../infra/config/index.js', () => ({
  loadPieceByIdentifier: mockLoadPieceByIdentifier,
  resolvePieceConfigValue: mockResolvePieceConfigValue,
}));

vi.mock('../core/piece/instruction/InstructionBuilder.js', () => ({
  InstructionBuilder: vi.fn().mockImplementation(() => ({
    build: mockInstructionBuild,
  })),
}));

vi.mock('../core/piece/instruction/ReportInstructionBuilder.js', () => ({
  ReportInstructionBuilder: vi.fn().mockImplementation(() => ({
    build: mockReportBuild,
  })),
}));

vi.mock('../core/piece/instruction/StatusJudgmentBuilder.js', () => ({
  StatusJudgmentBuilder: vi.fn().mockImplementation(() => ({
    build: mockJudgmentBuild,
  })),
}));

vi.mock('../core/piece/index.js', () => ({
  needsStatusJudgmentPhase: vi.fn(() => false),
}));

vi.mock('../shared/ui/index.js', () => ({
  header: mockHeader,
  info: mockInfo,
  error: mockError,
  blankLine: mockBlankLine,
}));

import { previewPrompts } from '../features/prompt/preview.js';

describe('previewPrompts', () => {
  let consoleLogSpy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockInstructionBuild.mockReturnValue('phase1');
    mockReportBuild.mockReturnValue('phase2');
    mockJudgmentBuild.mockReturnValue('phase3');
    mockResolvePieceConfigValue.mockImplementation((_: string, key: string) => {
      if (key === 'piece') return undefined;
      if (key === 'language') return 'en';
      return undefined;
    });
    mockLoadPieceByIdentifier.mockReturnValue({
      name: 'default',
      maxMovements: 1,
      movements: [
        {
          name: 'implement',
          personaDisplayName: 'coder',
          outputContracts: [],
        },
      ],
    });
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('piece未設定時はDEFAULT_PIECE_NAMEでロードする', async () => {
    await previewPrompts('/project');

    expect(mockLoadPieceByIdentifier).toHaveBeenCalledWith('default', '/project');
  });

  it('step番号の見出しを表示する', async () => {
    await previewPrompts('/project');

    expect(console.log).toHaveBeenCalledWith('Step 1: implement (persona: coder)');
  });

  it('ワークフロー用語でステップ数を表示する', async () => {
    await previewPrompts('/project');

    expect(mockInfo).toHaveBeenCalledWith('Steps: 1');
  });

  it('ヘッダーを workflow 用語で表示する', async () => {
    await previewPrompts('/project');

    expect(mockHeader).toHaveBeenCalledWith('Workflow Prompt Preview: default');
  });

  it('未存在ワークフローでは workflow 用語のエラーを表示し他の UI を出さない', async () => {
    mockLoadPieceByIdentifier.mockReturnValueOnce(undefined);

    await previewPrompts('/project', 'missing-workflow');

    expect(mockError).toHaveBeenCalledWith('Workflow "missing-workflow" not found.');
    expect(mockHeader).not.toHaveBeenCalled();
    expect(mockInfo).not.toHaveBeenCalled();
  });

  it('ワークフロー名とステップ表示の制御文字をサニタイズする', async () => {
    mockLoadPieceByIdentifier.mockReturnValueOnce({
      name: 'bad\x1b[31m-workflow\n',
      maxMovements: 1,
      movements: [
        {
          name: 'impl\tstep',
          personaDisplayName: 'coder\rname',
          outputContracts: [],
        },
      ],
    });

    await previewPrompts('/project');

    expect(mockHeader).toHaveBeenCalledWith('Workflow Prompt Preview: bad-workflow\\n');
    expect(console.log).toHaveBeenCalledWith('Step 1: impl\\tstep (persona: coder\\rname)');
  });
});
