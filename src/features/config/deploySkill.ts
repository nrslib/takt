/**
 * takt export-cc — Deploy takt skill files to Claude Code.
 */

import { deploySkillInternal } from './deploySkillInternal.js';

export async function deploySkill(): Promise<void> {
  await deploySkillInternal({
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
}
