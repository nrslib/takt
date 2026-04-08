/**
 * takt repertoire add — install a repertoire package from GitHub.
 *
 * Usage:
 *   takt repertoire add github:{owner}/{repo}@{ref}
 *   takt repertoire add github:{owner}/{repo}          (uses default branch)
 */

import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { stringify as stringifyYaml } from 'yaml';
import { getRepertoirePackageDir } from '../../infra/config/paths.js';
import { parseGithubSpec } from '../../features/repertoire/github-spec.js';
import {
  parseTaktRepertoireConfig,
  validateTaktRepertoirePath,
  validateMinVersion,
  isVersionCompatible,
  checkPackageHasContentWithContext,
  validateRealpathInsideRoot,
  resolveRepertoireConfigPath,
} from '../../features/repertoire/takt-repertoire-config.js';
import { collectCopyTargets } from '../../features/repertoire/file-filter.js';
import { parseTarVerboseListing } from '../../features/repertoire/tar-parser.js';
import { resolveRef } from '../../features/repertoire/github-ref-resolver.js';
import { atomicReplace, cleanupResiduals } from '../../features/repertoire/atomic-update.js';
import { generateLockFile, extractCommitSha } from '../../features/repertoire/lock-file.js';
import { TAKT_REPERTOIRE_MANIFEST_FILENAME, TAKT_REPERTOIRE_LOCK_FILENAME } from '../../features/repertoire/constants.js';
import { summarizeFacetsByType, detectEditWorkflows, formatEditWorkflowWarnings } from '../../features/repertoire/pack-summary.js';
import { confirm } from '../../shared/prompt/index.js';
import { info, success } from '../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';

const require = createRequire(import.meta.url);
const { version: TAKT_VERSION } = require('../../../package.json') as { version: string };

const GH_API_MAX_BUFFER_BYTES = 100 * 1024 * 1024;

const log = createLogger('repertoire-add');

export async function repertoireAddCommand(spec: string): Promise<void> {
  const { owner, repo, ref: specRef } = parseGithubSpec(spec);

  try {
    execFileSync('gh', ['--version'], {
      stdio: 'pipe',
      maxBuffer: GH_API_MAX_BUFFER_BYTES,
    });
  } catch {
    throw new Error(
      '`gh` CLI がインストールされていません。https://cli.github.com からインストールしてください',
    );
  }

  const execGh = (args: string[]) => execFileSync('gh', args, {
    encoding: 'utf-8',
    stdio: 'pipe',
    maxBuffer: GH_API_MAX_BUFFER_BYTES,
  });

  const execGhBinary = (args: string[]) => execFileSync('gh', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: GH_API_MAX_BUFFER_BYTES,
  });

  const ref = resolveRef(specRef, owner, repo, execGh);

  const tmpBase = join(tmpdir(), `takt-import-${Date.now()}`);
  const tmpTarPath = `${tmpBase}.tar.gz`;
  const tmpExtractDir = `${tmpBase}-extract`;
  const tmpIncludeFile = `${tmpBase}-include.txt`;

  try {
    mkdirSync(tmpExtractDir, { recursive: true });

    info(`📦 ${owner}/${repo} @${ref} をダウンロード中...`);
    const tarballBuffer = execGhBinary([
      'api',
      `/repos/${owner}/${repo}/tarball/${ref}`,
    ]);
    writeFileSync(tmpTarPath, tarballBuffer);

    const tarVerboseList = execFileSync('tar', ['tvzf', tmpTarPath], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    const verboseLines = tarVerboseList.split('\n').filter(l => l.trim());
    const { firstDirEntry, includePaths } = parseTarVerboseListing(verboseLines);

    const commitSha = extractCommitSha(firstDirEntry);

    if (includePaths.length > 0) {
      writeFileSync(tmpIncludeFile, includePaths.join('\n') + '\n');
      execFileSync(
        'tar',
        ['xzf', tmpTarPath, '-C', tmpExtractDir, '--strip-components=1', '-T', tmpIncludeFile],
        { stdio: 'pipe' },
      );
    }

    const packConfigPath = resolveRepertoireConfigPath(tmpExtractDir);

    const packConfigYaml = readFileSync(packConfigPath, 'utf-8');
    const config = parseTaktRepertoireConfig(packConfigYaml);
    validateTaktRepertoirePath(config.path);

    if (config.takt?.min_version) {
      validateMinVersion(config.takt.min_version);
      if (!isVersionCompatible(config.takt.min_version, TAKT_VERSION)) {
        throw new Error(
          `このパッケージは TAKT ${config.takt.min_version} 以降が必要です（現在: ${TAKT_VERSION}）`,
        );
      }
    }

    const packageRoot = config.path === '.' ? tmpExtractDir : join(tmpExtractDir, config.path);

    validateRealpathInsideRoot(packageRoot, tmpExtractDir);

    checkPackageHasContentWithContext(packageRoot, {
      manifestPath: packConfigPath,
      configuredPath: config.path,
    });

    const targets = collectCopyTargets(packageRoot);
    const facetFiles = targets.filter(t => t.relativePath.startsWith('facets/'));
    const workflowFiles = targets.filter(t => t.relativePath.startsWith('workflows/'));

    const facetSummary = summarizeFacetsByType(facetFiles.map(t => t.relativePath));

    const workflowYamls: Array<{ name: string; content: string }> = [];
    for (const workflowFile of workflowFiles) {
      try {
        const content = readFileSync(workflowFile.absolutePath, 'utf-8');
        workflowYamls.push({ name: workflowFile.relativePath.replace(/^workflows\//, ''), content });
      } catch (err) {
        log.debug('Failed to parse workflow YAML for edit check', { path: workflowFile.absolutePath, error: getErrorMessage(err) });
      }
    }
    const editWorkflows = detectEditWorkflows(workflowYamls);

    info(`\n📦 ${owner}/${repo} @${ref}`);
    info(`   facets:  ${facetSummary}`);
    if (workflowFiles.length > 0) {
      const workflowNames = workflowFiles.map(t =>
        t.relativePath.replace(/^workflows\//, '').replace(/\.yaml$/, ''),
      );
      info(`   workflows:  ${workflowFiles.length} (${workflowNames.join(', ')})`);
    } else {
      info('   workflows:  0');
    }
    for (const workflow of editWorkflows) {
      for (const warning of formatEditWorkflowWarnings(workflow)) {
        info(warning);
      }
    }
    info('');

    const confirmed = await confirm('インストールしますか？', false);
    if (!confirmed) {
      info('キャンセルしました');
      return;
    }

    const packageDir = getRepertoirePackageDir(owner, repo);

    if (existsSync(packageDir)) {
      info(`⚠ パッケージ @${owner}/${repo} は既にインストールされています`);
      const overwrite = await confirm(
        '上書きしますか？',
        false,
      );
      if (!overwrite) {
        info('キャンセルしました');
        return;
      }
    }

    cleanupResiduals(packageDir);

    await atomicReplace({
      packageDir,
      install: async () => {
        for (const target of targets) {
          const destFile = join(packageDir, target.relativePath);
          mkdirSync(dirname(destFile), { recursive: true });
          copyFileSync(target.absolutePath, destFile);
        }
        copyFileSync(packConfigPath, join(packageDir, TAKT_REPERTOIRE_MANIFEST_FILENAME));

        const lock = generateLockFile({
          source: `github:${owner}/${repo}`,
          ref,
          commitSha,
          importedAt: new Date(),
        });
        writeFileSync(join(packageDir, TAKT_REPERTOIRE_LOCK_FILENAME), stringifyYaml(lock));
      },
    });

    success(`✅ ${owner}/${repo} @${ref} をインストールしました`);
  } finally {
    if (existsSync(tmpTarPath)) rmSync(tmpTarPath, { force: true });
    if (existsSync(tmpExtractDir)) rmSync(tmpExtractDir, { recursive: true, force: true });
    if (existsSync(tmpIncludeFile)) rmSync(tmpIncludeFile, { force: true });
  }
}
