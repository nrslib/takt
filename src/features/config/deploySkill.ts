/**
 * takt export-cc — Deploy takt pieces and agents as Claude Code Skill.
 *
 * Copies the following to ~/.claude/:
 *   commands/takt.md          — /takt command entry point
 *   skills/takt/SKILL.md      — Engine overview
 *   skills/takt/references/   — Engine logic + YAML schema
 *   skills/takt/pieces/       — Builtin piece YAML files
 *   skills/takt/agents/       — Builtin agent .md files
 *
 * Piece YAML agent paths (../agents/...) work as-is because
 * the directory structure is mirrored.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, relative } from 'node:path';

import {
  getBuiltinPiecesDir,
  getBuiltinAgentsDir,
  getLanguage,
} from '../../infra/config/index.js';
import { getResourcesDir } from '../../infra/resources/index.js';
import { confirm } from '../../shared/prompt/index.js';
import { header, success, info, warn, blankLine } from '../../shared/ui/index.js';

/** Files to skip during directory copy */
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

/** Target paths under ~/.claude/ */
function getSkillDir(): string {
  return join(homedir(), '.claude', 'skills', 'takt');
}

function getCommandDir(): string {
  return join(homedir(), '.claude', 'commands');
}

/**
 * Deploy takt skill to Claude Code (~/.claude/).
 */
export async function deploySkill(): Promise<void> {
  header('takt export-cc — Deploy to Claude Code');

  const lang = getLanguage();
  const skillResourcesDir = join(getResourcesDir(), 'skill');
  const builtinPiecesDir = getBuiltinPiecesDir(lang);
  const builtinAgentsDir = getBuiltinAgentsDir(lang);
  const skillDir = getSkillDir();
  const commandDir = getCommandDir();

  // Verify source directories exist
  if (!existsSync(skillResourcesDir)) {
    warn('Skill resources not found. Ensure takt is installed correctly.');
    return;
  }

  // Check if skill already exists and ask for confirmation
  const skillExists = existsSync(join(skillDir, 'SKILL.md'));
  if (skillExists) {
    info('Claude Code Skill が既にインストールされています。');
    const overwrite = await confirm('上書きしますか？', false);
    if (!overwrite) {
      info('キャンセルしました。');
      return;
    }
    blankLine();
  }

  const copiedFiles: string[] = [];

  // 1. Deploy command file: ~/.claude/commands/takt.md
  const commandSrc = join(skillResourcesDir, 'takt-command.md');
  const commandDest = join(commandDir, 'takt.md');
  copyFile(commandSrc, commandDest, copiedFiles);

  // 2. Deploy SKILL.md
  const skillSrc = join(skillResourcesDir, 'SKILL.md');
  const skillDest = join(skillDir, 'SKILL.md');
  copyFile(skillSrc, skillDest, copiedFiles);

  // 3. Deploy references/ (engine.md, yaml-schema.md)
  const refsSrcDir = join(skillResourcesDir, 'references');
  const refsDestDir = join(skillDir, 'references');
  cleanDir(refsDestDir);
  copyDirRecursive(refsSrcDir, refsDestDir, copiedFiles);

  // 4. Deploy builtin piece YAMLs → skills/takt/pieces/
  const piecesDestDir = join(skillDir, 'pieces');
  cleanDir(piecesDestDir);
  copyDirRecursive(builtinPiecesDir, piecesDestDir, copiedFiles);

  // 5. Deploy builtin agent .md files → skills/takt/agents/
  const agentsDestDir = join(skillDir, 'agents');
  cleanDir(agentsDestDir);
  copyDirRecursive(builtinAgentsDir, agentsDestDir, copiedFiles);

  // Report results
  blankLine();
  if (copiedFiles.length > 0) {
    success(`${copiedFiles.length} ファイルをデプロイしました。`);
    blankLine();

    // Show summary by category
    const skillBase = join(homedir(), '.claude');
    const commandFiles = copiedFiles.filter((f) => f.startsWith(commandDir));
    const skillFiles = copiedFiles.filter(
      (f) => f.startsWith(skillDir) && !f.includes('/pieces/') && !f.includes('/agents/'),
    );
    const pieceFiles = copiedFiles.filter((f) => f.includes('/pieces/'));
    const agentFiles = copiedFiles.filter((f) => f.includes('/agents/'));

    if (commandFiles.length > 0) {
      info(`  コマンド: ${commandFiles.length} ファイル`);
      for (const f of commandFiles) {
        info(`    ${relative(skillBase, f)}`);
      }
    }
    if (skillFiles.length > 0) {
      info(`  スキル:   ${skillFiles.length} ファイル`);
      for (const f of skillFiles) {
        info(`    ${relative(skillBase, f)}`);
      }
    }
    if (pieceFiles.length > 0) {
      info(`  ピース:   ${pieceFiles.length} ファイル`);
    }
    if (agentFiles.length > 0) {
      info(`  エージェント: ${agentFiles.length} ファイル`);
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
