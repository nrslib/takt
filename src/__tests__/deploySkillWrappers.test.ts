import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../features/config/deploySkillInternal.js', () => ({
  deploySkillInternal: vi.fn().mockResolvedValue(undefined),
}));

const { deploySkill } = await import('../features/config/deploySkill.js');
const { deploySkillCodex } = await import('../features/config/deploySkillCodex.js');
const { deploySkillInternal } = await import('../features/config/deploySkillInternal.js');

describe('deploy skill wrappers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should delegate export-cc configuration to shared deploy implementation', async () => {
    await deploySkill();

    expect(deploySkillInternal).toHaveBeenCalledTimes(1);
    expect(deploySkillInternal).toHaveBeenCalledWith({
      headerTitle: 'takt export-cc — Deploy to Claude Code',
      skillRootDir: '.claude',
      skillResourceDirName: 'skill',
      existingInstallMessage: 'Claude Code Skill が既にインストールされています。',
      usageCommand: '使い方: /takt <piece-name> <task>',
      usageExample: '例:     /takt passthrough "Hello World テスト"',
      showReferencesSummary: false,
      includeAgentsDirectory: false,
      showAgentsSummary: false,
    });
  });

  it('should delegate export-codex configuration to shared deploy implementation', async () => {
    await deploySkillCodex();

    expect(deploySkillInternal).toHaveBeenCalledTimes(1);
    expect(deploySkillInternal).toHaveBeenCalledWith({
      headerTitle: 'takt export-codex — Deploy to Codex',
      skillRootDir: '.agents',
      skillResourceDirName: 'skill-codex',
      existingInstallMessage: 'Codex Skill が既にインストールされています。',
      usageCommand: '使い方: $takt <piece-name> <task>',
      usageExample: '例:     $takt passthrough "Hello World テスト"',
      showReferencesSummary: true,
      includeAgentsDirectory: true,
      showAgentsSummary: true,
    });
  });
});
