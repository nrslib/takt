/**
 * takt export-cc — Deploy takt skill files to Claude Code.
 *
 * Copies the following to ~/.claude/skills/takt/:
 *   SKILL.md                  — Engine overview (user-invocable as /takt)
 *   references/               — Engine logic + YAML schema
 *   pieces/                   — Builtin piece YAML files
 *   personas/                 — Builtin persona .md files
 *   policies/                 — Builtin policy files
 *   instructions/             — Builtin instruction files
 *   knowledge/                — Builtin knowledge files
 *   output-contracts/         — Builtin output contract files
 *   templates/                — Builtin template files
 *
 * Piece YAML persona paths (../personas/...) work as-is because
 * the directory structure is mirrored.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, relative } from 'node:path';

import { getLanguage } from '../../infra/config/index.js';
import { getResourcesDir, getLanguageResourcesDir } from '../../infra/resources/index.js';
import { confirm } from '../../shared/prompt/index.js';
import { header, success, info, warn, blankLine } from '../../shared/ui/index.js';

/** Files to skip during directory copy */
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

/** Target paths under ~/.claude/ */
function getSkillDir(): string {
  return join(homedir(), '.claude', 'skills', 'takt');
}

/** Directories directly under builtins/{lang}/ */
const DIRECT_DIRS = ['pieces', 'templates'] as const;

/** Facet directories under builtins/{lang}/facets/ */
const FACET_DIRS = ['personas', 'policies', 'instructions', 'knowledge', 'output-contracts'] as const;

/** All resource directory names (used for summary filtering) */
const RESOURCE_DIRS = [...DIRECT_DIRS, ...FACET_DIRS] as const;

/**
 * Deploy takt skill to Claude Code (~/.claude/).
 */
export async function deploySkill(): Promise<void> {
  header('takt export-cc — Deploy to Claude Code');

  const lang = getLanguage();
  const skillResourcesDir = join(getResourcesDir(), 'skill');
  const langResourcesDir = getLanguageResourcesDir(lang);
  const skillDir = getSkillDir();

  // Verify source directories exist
  if (!existsSync(skillResourcesDir)) {
    warn('Skill resources not found. Ensure takt is installed correctly.');
    return;
  }

  // Check if skill already exists and ask for confirmation
  const skillExists = existsSync(join(skillDir, 'SKILL.md'));
  if (skillExists) {
    info('Claude Code Skill が既にインストールされています。');
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

  // 1. Deploy SKILL.md
  const skillSrc = join(skillResourcesDir, 'SKILL.md');
  const skillDest = join(skillDir, 'SKILL.md');
  copyFile(skillSrc, skillDest, copiedFiles);

  // 2. Deploy references/ (engine.md, yaml-schema.md)
  const refsSrcDir = join(skillResourcesDir, 'references');
  const refsDestDir = join(skillDir, 'references');
  cleanDir(refsDestDir);
  copyDirRecursive(refsSrcDir, refsDestDir, copiedFiles);

  // 3. Deploy direct resource directories from builtins/{lang}/
  for (const dir of DIRECT_DIRS) {
    const srcDir = join(langResourcesDir, dir);
    const destDir = join(skillDir, dir);
    cleanDir(destDir);
    copyDirRecursive(srcDir, destDir, copiedFiles);
  }

  // 4. Deploy facet directories from builtins/{lang}/facets/
  for (const dir of FACET_DIRS) {
    const srcDir = join(langResourcesDir, 'facets', dir);
    const destDir = join(skillDir, dir);
    cleanDir(destDir);
    copyDirRecursive(srcDir, destDir, copiedFiles);
  }

  // Report results
  blankLine();
  if (copiedFiles.length > 0) {
    success(`${copiedFiles.length} ファイルをデプロイしました。`);
    blankLine();

    // Show summary by category
    const skillBase = join(homedir(), '.claude');
    const skillFiles = copiedFiles.filter(
      (f) =>
        f.startsWith(skillDir) &&
        !RESOURCE_DIRS.some((dir) => f.includes(`/${dir}/`)),
    );
    const pieceFiles = copiedFiles.filter((f) => f.includes('/pieces/'));
    const personaFiles = copiedFiles.filter((f) => f.includes('/personas/'));
    const policyFiles = copiedFiles.filter((f) => f.includes('/policies/'));
    const instructionFiles = copiedFiles.filter((f) => f.includes('/instructions/'));
    const knowledgeFiles = copiedFiles.filter((f) => f.includes('/knowledge/'));
    const outputContractFiles = copiedFiles.filter((f) => f.includes('/output-contracts/'));
    const templateFiles = copiedFiles.filter((f) => f.includes('/templates/'));

    if (skillFiles.length > 0) {
      info(`  スキル:        ${skillFiles.length} ファイル`);
      for (const f of skillFiles) {
        info(`    ${relative(skillBase, f)}`);
      }
    }
    if (pieceFiles.length > 0) {
      info(`  ピース:        ${pieceFiles.length} ファイル`);
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
    if (templateFiles.length > 0) {
      info(`  テンプレート:  ${templateFiles.length} ファイル`);
    }

    blankLine();
    info('使い方: /takt <piece-name> <task>');
    info('例:     /takt passthrough "Hello World テスト"');
  } else {
    info('デプロイするファイルがありませんでした。');
  }
}

/** Remove a directory and all its contents so stale files don't persist across deploys. */
function cleanDir(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true });
  }
}

/** Copy a single file, creating parent directories as needed. */
function copyFile(src: string, dest: string, copiedFiles: string[]): void {
  if (!existsSync(src)) return;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(src));
  copiedFiles.push(dest);
}

/** Recursively copy directory contents, always overwriting. */
function copyDirRecursive(srcDir: string, destDir: string, copiedFiles: string[]): void {
  if (!existsSync(srcDir)) return;
  mkdirSync(destDir, { recursive: true });

  for (const entry of readdirSync(srcDir)) {
    if (SKIP_FILES.has(entry)) continue;

    const srcPath = join(srcDir, entry);
    const destPath = join(destDir, entry);
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      copyDirRecursive(srcPath, destPath, copiedFiles);
    } else {
      writeFileSync(destPath, readFileSync(srcPath));
      copiedFiles.push(destPath);
    }
  }
}
