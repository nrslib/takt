import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROVIDER_TYPES } from '../shared/types/provider.js';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const guideFiles = [
  { path: 'README.md', language: 'en' },
  { path: 'docs/README.ja.md', language: 'ja' },
  { path: 'docs/README.zh-CN.md', language: 'zh-CN' },
  { path: 'docs/configuration.md', language: 'en' },
  { path: 'docs/configuration.ja.md', language: 'ja' },
  { path: 'docs/configuration.zh-CN.md', language: 'zh-CN' },
  { path: 'docs/cli-reference.md', language: 'en' },
  { path: 'docs/cli-reference.ja.md', language: 'ja' },
  { path: 'docs/cli-reference.zh-CN.md', language: 'zh-CN' },
] as const;

type GuideLanguage = (typeof guideFiles)[number]['language'];

const readmeCredentialGuidancePatterns: Record<GuideLanguage, RegExp> = {
  en: /Or use provider credentials directly/iu,
  ja: /provider の認証情報を直接使う場合/iu,
  'zh-CN': /直接使用 provider 凭据/iu,
};

const oneTimeInstallPatterns: Record<GuideLanguage, RegExp> = {
  en: /\bonce\b|one[- ]time/iu,
  ja: /一度|一回/iu,
  'zh-CN': /一次/iu,
};

const pipMigrationPatterns: Record<GuideLanguage, RegExp> = {
  en: /migrat|move|instead|replace/iu,
  ja: /移行|移し|置き換え/iu,
  'zh-CN': /迁移|改用|替代|切换/iu,
};

const npmLifecycleSemanticPatterns: Record<GuideLanguage, RegExp> = {
  en: /npm\s+install[^.!?。！？\n]{0,80}npm\s+lifecycle[^.!?。！？\n]{0,80}(?:never|do not|does not|cannot|can't)[^.!?。！？\n]{0,40}(?:build|create|repair)/iu,
  ja: /npm\s+install[^。！？\n]{0,80}npm\s+lifecycle[^。！？\n]{0,80}(?:構築|作成|修復)[^。！？\n]{0,24}(?:せず|しない|しません|行わない|できない)/u,
  'zh-CN': /npm\s+install[^。！？\n]{0,80}npm\s+lifecycle[^。！？\n]{0,80}(?:不会|不|未|无法)[^。！？\n]{0,24}(?:构建|创建|修复)/iu,
};

const providerInstallSemanticPatterns: Record<GuideLanguage, {
  failure: RegExp;
  noWait: RegExp;
}> = {
  en: {
    failure: /unsupported|may\s+fail|incomplete\s+environment|can\s+fail/iu,
    noWait: /does\s+not\s+wait\s+for\s+(?:the\s+)?installer\s+lock/iu,
  },
  ja: {
    failure: /未対応|失敗/u,
    noWait: /installer\s+lock\s*を\s*(?:待たない|待たず)/u,
  },
  'zh-CN': {
    failure: /不受支持|失败/u,
    noWait: /(?:provider[\s\S]{0,20})?(?:不会|不)\s*等待\s*installer\s+lock/iu,
  },
};

const systemPythonSemanticPatterns: Record<GuideLanguage, RegExp> = {
  en: /(?:system\s+Python[^.!?。！？\n]{0,60}(?:not\s+required|not\s+needed|unnecessary|does\s+not\s+need\s+to\s+be\s+installed)|(?:not\s+required|not\s+needed|unnecessary)[^.!?。！？\n]{0,60}system\s+Python)/iu,
  ja: /(?:system\s+Python[^。！？\n]{0,60}(?:不要|必要(?:ありません|ない))|(?:不要|必要(?:ありません|ない))[^。！？\n]{0,60}system\s+Python)/u,
  'zh-CN': /(?:system\s+Python[^。！？\n]{0,60}(?:不需要|无需|不必|不要求|不必要)|(?:不需要|无需|不必|不要求|不必要)[^。！？\n]{0,60}system\s+Python)/iu,
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const nonDeepSeekProviderPatterns = PROVIDER_TYPES
  .filter((provider) => provider !== 'deepseek-harness')
  .map((provider) => new RegExp(
    `(?<![\\p{L}\\p{N}_-])${escapeRegExp(provider)}(?![\\p{L}\\p{N}_-])`,
    'iu',
  ));
const deepSeekProviderPattern = /(?<![\p{L}\p{N}_-])deepseek[-_\s]+harness(?![\p{L}\p{N}_-])/iu;
const managedEnvironmentPrerequisitePattern = /\buv\b|managed[\s-]+environment|managed[\s-]+interpreter/iu;

interface Heading {
  readonly level: number;
  readonly index: number;
}

function findHeading(line: string, index: number): Heading | undefined {
  const match = /^(#{2,6})\s+/u.exec(line);
  const marker = match?.[1];
  return marker === undefined ? undefined : { level: marker.length, index };
}

function extractSection(lines: readonly string[], heading: Heading): string {
  const sectionEnd = lines.findIndex((line, index) => {
    if (index <= heading.index) {
      return false;
    }
    const nextHeading = findHeading(line, index);
    return nextHeading !== undefined && nextHeading.level <= heading.level;
  });
  return lines.slice(heading.index, sectionEnd === -1 ? lines.length : sectionEnd).join('\n');
}

function extractDeepSeekGuidance(document: string): string {
  const lines = document.split('\n');
  const deepSeekHeading = lines
    .map((line, index) => findHeading(line, index))
    .find((heading) => {
      if (heading === undefined) {
        return false;
      }
      const headingLine = lines[heading.index];
      return headingLine !== undefined && /DeepSeek Harness/iu.test(headingLine);
    });
  if (deepSeekHeading !== undefined) {
    return extractSection(lines, deepSeekHeading);
  }

  const guidanceStart = lines.findIndex((line) => (
    /deepseek-harness/iu.test(line) && /npm\s+install/iu.test(line)
  ));
  if (guidanceStart === -1) {
    throw new Error('DeepSeek Harness guidance section is missing');
  }

  let containingHeading: Heading | undefined;
  for (let index = guidanceStart - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    const heading = findHeading(line, index);
    if (heading !== undefined) {
      containingHeading = heading;
      break;
    }
  }
  return containingHeading === undefined
    ? lines.slice(guidanceStart).join('\n')
    : extractSection(lines, containingHeading);
}

function readGuide(path: string): string {
  return readFileSync(join(repositoryRoot, path), 'utf8');
}

function paragraphs(section: string): string[] {
  return section
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

function providerClauses(document: string): string[] {
  return paragraphs(document).filter((paragraph) => (
    nonDeepSeekProviderPatterns.some((pattern) => pattern.test(paragraph))
    && !deepSeekProviderPattern.test(paragraph)
  ));
}

function fencedCodeBlocks(document: string): string[] {
  const blocks: string[] = [];
  for (const match of document.matchAll(/```[^\n]*\n([\s\S]*?)```/gu)) {
    const block = match[1];
    if (block !== undefined) {
      blocks.push(block);
    }
  }
  return blocks;
}

function primarySourcesOf(entry: string): string[] {
  const prefix = '- **Primary sources**: ';
  const line = entry.split('\n').find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) {
    throw new Error('Primary sources are missing from the decision entry');
  }
  return line
    .slice(prefix.length)
    .split(';')
    .map((source) => source.trim().replace(/^`|`$/gu, ''));
}

describe('managed environment documentation', () => {
  it('describes the same DeepSeek-only managed environment prerequisites in all supported guides', () => {
    for (const guide of guideFiles) {
      const document = readGuide(guide.path);
      const guidance = extractDeepSeekGuidance(document);
      const guidanceParagraphs = paragraphs(guidance);
      const installerLockParagraph = guidanceParagraphs.find((paragraph) => (
        /provider/iu.test(paragraph) && /installer\s+lock/iu.test(paragraph)
      ));
      const npmLifecycleParagraph = guidanceParagraphs.find((paragraph) => (
        /npm\s+install/iu.test(paragraph) && /npm\s+lifecycle/iu.test(paragraph)
      ));
      const systemPythonParagraph = guidanceParagraphs.find((paragraph) => (
        /system\s+Python/iu.test(paragraph)
      ));

      expect(guidance, guide.path).toMatch(/deepseek-harness/iu);
      expect(guidance, guide.path).toMatch(/managed environment/iu);
      expect(guidance, guide.path).toMatch(/uv-managed CPython 3\.12/iu);
      expect(guidance, guide.path).toMatch(oneTimeInstallPatterns[guide.language]);
      expect(guidance, guide.path).toMatch(/npm\s+install/iu);
      expect(guidance, guide.path).toMatch(/npm\s+lifecycle/iu);
      expect(installerLockParagraph, guide.path).toBeDefined();
      expect(npmLifecycleParagraph, guide.path).toBeDefined();
      expect(systemPythonParagraph, guide.path).toBeDefined();
      expect(guidance, guide.path).toMatch(/Linux\s+x64\s*\/\s*arm64/iu);
      expect(guidance, guide.path).toMatch(/macOS\s+arm64/iu);
      expect(guidance, guide.path).toMatch(/system\s+Python/iu);

      if (installerLockParagraph === undefined) {
        throw new Error(`Installer lock guidance is missing from ${guide.path}`);
      }
      if (npmLifecycleParagraph === undefined) {
        throw new Error(`npm lifecycle guidance is missing from ${guide.path}`);
      }
      if (systemPythonParagraph === undefined) {
        throw new Error(`system Python guidance is missing from ${guide.path}`);
      }

      expect(npmLifecycleParagraph, guide.path).toMatch(
        npmLifecycleSemanticPatterns[guide.language],
      );
      expect(installerLockParagraph, guide.path).toMatch(
        providerInstallSemanticPatterns[guide.language].failure,
      );
      expect(installerLockParagraph, guide.path).toMatch(
        providerInstallSemanticPatterns[guide.language].noWait,
      );
      expect(systemPythonParagraph, guide.path).toMatch(
        systemPythonSemanticPatterns[guide.language],
      );

      for (const providerClause of providerClauses(document)) {
        expect(providerClause, `${guide.path} non-DeepSeek provider clause`)
          .not.toMatch(managedEnvironmentPrerequisitePattern);
      }
    }
  });

  it('requires a managed install in each README credential guide for DeepSeek Harness', () => {
    for (const guide of guideFiles.filter((candidate) => candidate.path.includes('README'))) {
      const credentialParagraph = paragraphs(readGuide(guide.path)).find((paragraph) => (
        readmeCredentialGuidancePatterns[guide.language].test(paragraph)
      ));

      expect(credentialParagraph, guide.path).toBeDefined();
      expect(credentialParagraph, guide.path).toMatch(/takt\s+deepseek-harness\s+install/iu);
    }
  });

  it('documents the option removal and pip-to-uv migration without preserving old procedures', () => {
    for (const guide of guideFiles) {
      const document = readGuide(guide.path);
      const guidance = extractDeepSeekGuidance(document);
      const guidanceParagraphs = paragraphs(guidance);
      const removedOptionParagraph = guidanceParagraphs.find((paragraph) => (
        paragraph.includes('--python') && paragraph.includes('python_path')
      ));
      const migrationParagraph = guidanceParagraphs.find((paragraph) => (
        /UV_INDEX_URL/iu.test(paragraph)
        && /proxy/iu.test(paragraph)
        && /certificate/iu.test(paragraph)
        && /\bpip\b/iu.test(paragraph)
        && pipMigrationPatterns[guide.language].test(paragraph)
        && /--locked/iu.test(paragraph)
      ));

      expect(removedOptionParagraph, guide.path).toBeDefined();
      expect(removedOptionParagraph, guide.path).toMatch(
        /removed|not supported|unsupported|does not accept|削除|廃止|受け付け|サポートしません|已删除|删除|不接受|不支持/iu,
      );
      expect(migrationParagraph, guide.path).toBeDefined();
      expect(guidance, guide.path).not.toMatch(/\buv\s+cache\b|cache directory|キャッシュ(?:ディレクトリ|フォルダー)|缓存(?:目录|文件夹)/iu);

      for (const codeBlock of fencedCodeBlocks(document)) {
        expect(codeBlock, `${guide.path} executable example`).not.toMatch(/--python|python_path/iu);
      }
    }
  });

  it('records one managed environment decision with the required primary sources', () => {
    const decisionLog = readFileSync(join(repositoryRoot, 'docs', 'decision-log.md'), 'utf8');
    const entries = decisionLog
      .split(/^##\s+/mu)
      .filter((entry) => /^Managed DeepSeek Harness environment\b/iu.test(entry));

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (entry === undefined) {
      throw new Error('Managed DeepSeek Harness decision entry is missing');
    }

    expect(entry).toMatch(/uv project/iu);
    expect(entry).toMatch(/uv-managed CPython 3\.12/iu);
    expect(entry).toMatch(/npm\s+lifecycle/iu);
    expect(entry).toMatch(/--python/iu);
    expect(entry).toMatch(/python_path/iu);
    const primarySources = primarySourcesOf(entry);
    expect(primarySources).toEqual(expect.arrayContaining([
      'https://github.com/nrslib/takt/issues/1560',
      'src/infra/deepseek-harness/pyproject.toml',
      'src/infra/deepseek-harness/uv.lock',
      'https://docs.astral.sh/uv/concepts/projects/sync/',
      'https://docs.astral.sh/uv/concepts/python-versions/',
      'https://docs.astral.sh/uv/concepts/cache/#cache-safety.',
    ]));
    for (const source of primarySources) {
      if (source.startsWith('https://')) {
        expect(source).toMatch(/^https:\/\/\S+$/u);
        expect(() => new URL(source)).not.toThrow();
        continue;
      }

      expect(source).not.toMatch(/^context(?:\/|$)/u);
      const sourceStats = statSync(join(repositoryRoot, source), { throwIfNoEntry: false });
      expect(sourceStats?.isFile(), source).toBe(true);

      const gitResult = spawnSync(
        'git',
        ['ls-files', '--cached', '--error-unmatch', '--', source],
        { cwd: repositoryRoot, encoding: 'utf8' },
      );
      if (gitResult.error !== undefined) {
        throw gitResult.error;
      }
      expect(gitResult.status, `${gitResult.stdout}\n${gitResult.stderr}`).toBe(0);
      expect(gitResult.stdout.trim(), source).toBe(source);
    }
  });
});
