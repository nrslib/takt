import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, relative } from 'node:path';

import { getLanguage } from '../../infra/config/index.js';
import { getResourcesDir, getLanguageResourcesDir } from '../../infra/resources/index.js';
import { confirm } from '../../shared/prompt/index.js';
import { header, success, info, warn, blankLine } from '../../shared/ui/index.js';

const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);
const DIRECT_DIRS = ['pieces'] as const;
const FACET_DIRS = ['personas', 'policies', 'instructions', 'knowledge', 'output-contracts'] as const;

export type DeploySkillOptions = {
  headerTitle: string;
  skillRootDir: string;
  skillResourceDirName: string;
  existingInstallMessage: string;
  usageCommand: string;
  usageExample: string;
  showReferencesSummary: boolean;
  includeAgentsDirectory: boolean;
  showAgentsSummary: boolean;
};

export async function deploySkillInternal(options: DeploySkillOptions): Promise<void> {
  header(options.headerTitle);

  const lang = getLanguage();
  const skillResourcesDir = join(getResourcesDir(), options.skillResourceDirName);
  const langResourcesDir = getLanguageResourcesDir(lang);
  const skillDir = join(homedir(), options.skillRootDir, 'skills', 'takt');

  if (!existsSync(skillResourcesDir)) {
    warn('Skill resources not found. Ensure takt is installed correctly.');
    return;
  }

  const skillExists = existsSync(join(skillDir, 'SKILL.md'));
  if (skillExists) {
    info(options.existingInstallMessage);
    const overwrite = await confirm(
      '既存のスキルファイルをすべて削除し、最新版に置き換えます。続行しますか？',
      false,
    );
    if (!overwrite) {
      info('キャンセルしました。');
      return;
    }
    blankLine();
  }

  const copiedFiles: string[] = [];
  cleanDir(join(skillDir, 'templates'));

  copyFile(join(skillResourcesDir, 'SKILL.md'), join(skillDir, 'SKILL.md'), copiedFiles);

  const referencesDestDir = join(skillDir, 'references');
  cleanDir(referencesDestDir);
  copyDirRecursive(join(skillResourcesDir, 'references'), referencesDestDir, copiedFiles);

  if (options.includeAgentsDirectory) {
    const agentsDestDir = join(skillDir, 'agents');
    cleanDir(agentsDestDir);
    copyDirRecursive(join(skillResourcesDir, 'agents'), agentsDestDir, copiedFiles);
  }

  for (const dir of DIRECT_DIRS) {
    const destDir = join(skillDir, dir);
    cleanDir(destDir);
    copyDirRecursive(join(langResourcesDir, dir), destDir, copiedFiles);
  }

  const facetsDestDir = join(skillDir, 'facets');
  cleanDir(facetsDestDir);
  for (const dir of FACET_DIRS) {
    copyDirRecursive(join(langResourcesDir, 'facets', dir), join(facetsDestDir, dir), copiedFiles);
  }

  blankLine();
  if (copiedFiles.length === 0) {
    info('デプロイするファイルがありませんでした。');
    return;
  }

  success(`${copiedFiles.length} ファイルをデプロイしました。`);
  blankLine();

  const skillBase = join(homedir(), options.skillRootDir);
  const skillFiles = copiedFiles.filter(
    (filePath) =>
      filePath.startsWith(skillDir)
      && !filePath.includes('/pieces/')
      && !filePath.includes('/facets/')
      && !filePath.includes('/references/')
      && !filePath.includes('/agents/'),
  );
  const referenceFiles = copiedFiles.filter((filePath) => filePath.includes('/references/'));
  const agentFiles = copiedFiles.filter((filePath) => filePath.includes('/agents/'));
  const pieceFiles = copiedFiles.filter((filePath) => filePath.includes('/pieces/'));
  const personaFiles = copiedFiles.filter((filePath) => filePath.includes('/facets/personas/'));
  const policyFiles = copiedFiles.filter((filePath) => filePath.includes('/facets/policies/'));
  const instructionFiles = copiedFiles.filter((filePath) => filePath.includes('/facets/instructions/'));
  const knowledgeFiles = copiedFiles.filter((filePath) => filePath.includes('/facets/knowledge/'));
  const outputContractFiles = copiedFiles.filter((filePath) => filePath.includes('/facets/output-contracts/'));

  if (skillFiles.length > 0) {
    info(`  スキル:        ${skillFiles.length} ファイル`);
    for (const filePath of skillFiles) {
      info(`    ${relative(skillBase, filePath)}`);
    }
  }
  if (options.showReferencesSummary && referenceFiles.length > 0) {
    info(`  参照資料:      ${referenceFiles.length} ファイル`);
  }
  if (options.showAgentsSummary && agentFiles.length > 0) {
    info(`  エージェント設定: ${agentFiles.length} ファイル`);
  }
  if (pieceFiles.length > 0) {
    info(`  ワークフロー:  ${pieceFiles.length} ファイル`);
  }
  if (personaFiles.length > 0) {
    info(`  ペルソナ:      ${personaFiles.length} ファイル`);
  }
  if (policyFiles.length > 0) {
    info(`  ポリシー:      ${policyFiles.length} ファイル`);
  }
  if (instructionFiles.length > 0) {
    info(`  インストラクション: ${instructionFiles.length} ファイル`);
  }
  if (knowledgeFiles.length > 0) {
    info(`  ナレッジ:      ${knowledgeFiles.length} ファイル`);
  }
  if (outputContractFiles.length > 0) {
    info(`  出力契約:      ${outputContractFiles.length} ファイル`);
  }

  blankLine();
  info(options.usageCommand);
  info(options.usageExample);
}

function cleanDir(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true });
  }
}

function copyFile(src: string, dest: string, copiedFiles: string[]): void {
  if (!existsSync(src)) {
    return;
  }

  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(src));
  copiedFiles.push(dest);
}

function copyDirRecursive(srcDir: string, destDir: string, copiedFiles: string[]): void {
  if (!existsSync(srcDir)) {
    return;
  }

  mkdirSync(destDir, { recursive: true });

  for (const entry of readdirSync(srcDir)) {
    if (SKIP_FILES.has(entry)) {
      continue;
    }

    const srcPath = join(srcDir, entry);
    const destPath = join(destDir, entry);
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      copyDirRecursive(srcPath, destPath, copiedFiles);
      continue;
    }

    writeFileSync(destPath, readFileSync(srcPath));
    copiedFiles.push(destPath);
  }
}
