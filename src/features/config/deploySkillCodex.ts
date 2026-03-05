/**
 * takt export-codex — Deploy takt skill files to Codex.
 */

import { deploySkillInternal } from './deploySkillInternal.js';

export async function deploySkillCodex(): Promise<void> {
  await deploySkillInternal({
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
}
