import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  createIsolatedEnv,
  updateIsolatedConfig,
  type IsolatedEnv,
} from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { mkdirSync, writeFileSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface RunMetaJson {
  status: string;
  source_run_slug?: string;
  resume_artifacts?: string;
  current_step?: string;
  currentStep?: string;
}

function listRunSlugs(repoPath: string): string[] {
  const runsDir = join(repoPath, '.takt', 'runs');
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function readMeta(repoPath: string, slug: string): RunMetaJson {
  return JSON.parse(
    readFileSync(join(repoPath, '.takt', 'runs', slug, 'meta.json'), 'utf-8'),
  ) as RunMetaJson;
}

// E2E更新時は docs/testing/e2e.md も更新すること
//
// v3-r4 の resume 境界バグの再現条件そのものを固定する:
// producer（first-review）がレポートを書いた後、consumer（arbitrate）で abort。
// resume（新 run slug）で resume 位置が consumer 自身になるため、旧 run の
// reports/ を継承しないと {report:first-review.md} が構造的に解決不能になる。
describe('E2E: Resume inherits the source run report snapshot (mock)', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider: 'mock',
    });
    repo = createLocalRepo();
  });

  afterEach(() => {
    try { repo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  it('should resume the arbitrate step with the inherited report from the aborted run', () => {
    // `takt resume` は meta.workflow の識別子（= ファイル basename）で
    // ワークフローを再解決するため、プロジェクトの workflows 直下へ置く
    // （copyWorkflowFixtureToRepo の e2e-fixtures 配下では発見できない）。
    const workflowPath = join(repo.path, '.takt', 'workflows', 'resume-arbitrate.yaml');
    mkdirSync(dirname(workflowPath), { recursive: true });
    writeFileSync(workflowPath, readFileSync(
      resolve(__dirname, '../fixtures/workflows/resume-arbitrate.yaml'),
    ));

    // 1走目: first-review がレポートを書き、arbitrate でプロバイダ失敗 → abort。
    const firstRun = runTakt({
      args: [
        '--task', 'Resume inheritance repro',
        '--workflow', workflowPath,
        '--provider', 'mock',
      ],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: resolve(__dirname, '../fixtures/scenarios/resume-arbitrate-first.json'),
      },
      timeout: 240_000,
    });
    expect(firstRun.exitCode).not.toBe(0);

    const firstSlugs = listRunSlugs(repo.path);
    expect(firstSlugs.length).toBe(1);
    const sourceSlug = firstSlugs[0]!;
    const sourceMeta = readMeta(repo.path, sourceSlug);
    expect(['aborted', 'failed']).toContain(sourceMeta.status);
    const sourceReport = join(repo.path, '.takt', 'runs', sourceSlug, 'reports', 'first-review.md');
    expect(existsSync(sourceReport)).toBe(true);
    const sourceReportContent = readFileSync(sourceReport, 'utf-8');

    // 2走目: takt resume（非TTYでは先頭アクション Requeue が自動選択される）。
    // resume 位置は abort したステップ（arbitrate = consumer 自身）。
    const resumeRun = runTakt({
      args: ['resume'],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: resolve(__dirname, '../fixtures/scenarios/resume-arbitrate-second.json'),
      },
      timeout: 240_000,
    });
    expect(resumeRun.exitCode).toBe(0);

    const newSlugs = listRunSlugs(repo.path).filter((slug) => slug !== sourceSlug);
    expect(newSlugs.length).toBe(1);
    const resumedSlug = newSlugs[0]!;
    const resumedMeta = readMeta(repo.path, resumedSlug);

    // 新 run は旧 run の reports/ を継承したスナップショットを持つ。
    const inheritedReport = join(repo.path, '.takt', 'runs', resumedSlug, 'reports', 'first-review.md');
    expect(existsSync(inheritedReport)).toBe(true);
    expect(readFileSync(inheritedReport, 'utf-8')).toBe(sourceReportContent);

    // meta.json は source と manifest への参照を持ち、manifest（SSOT）に
    // 継承ファイルが記録されている。
    expect(resumedMeta.source_run_slug).toBe(sourceSlug);
    // manifest は reports スナップショットの内側の予約名（単一 rename 公開）。
    expect(resumedMeta.resume_artifacts).toBe(`.takt/runs/${resumedSlug}/reports/resume-artifacts.json`);
    const manifest = JSON.parse(readFileSync(
      join(repo.path, '.takt', 'runs', resumedSlug, 'reports', 'resume-artifacts.json'),
      'utf-8',
    )) as { sourceRunSlug: string; files: Array<{ path: string; sha256: string }> };
    expect(manifest.sourceRunSlug).toBe(sourceSlug);
    expect(manifest.files.some((file) => file.path === 'first-review.md')).toBe(true);

    // consumer 自身から resume して完走する（v3-r4 では構造的に不可能だった）。
    expect(resumedMeta.status).toBe('completed');
  }, 480_000);
});
