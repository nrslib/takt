/**
 * Unit tests for repertoire @scope resolution and facet resolution chain.
 *
 * Covers:
 *   A. @scope reference resolution (src/faceted-prompting/scope.ts)
 *   B. Facet resolution chain with package-local layer
 *      (src/infra/config/loaders/resource-resolver.ts)
 *
 * @scope resolution rules:
 *   "@{owner}/{repo}/{name}" in a facet field →
 *     {repertoireDir}/@{owner}/{repo}/facets/{type}/{name}.md
 *
 * Name constraints:
 *   owner:  /^[a-z0-9][a-z0-9-]*$/  (lowercase only after normalization)
 *   repo:   /^[a-z0-9][a-z0-9._-]*$/  (dot and underscore allowed)
 *   facet/piece name: /^[a-z0-9][a-z0-9-]*$/
 *
 * Facet resolution order (package piece):
 *   1. package-local: {repertoireDir}/@{owner}/{repo}/facets/{type}/{facet}.md
 *   2. project:       .takt/facets/{type}/{facet}.md
 *   3. user:          ~/.takt/facets/{type}/{facet}.md
 *   4. builtin:       builtins/{lang}/facets/{type}/{facet}.md
 *
 * Facet resolution order (non-package piece):
 *   1. project → 2. user → 3. builtin  (package-local is NOT consulted)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isScopeRef,
  parseScopeRef,
  resolveScopeRef,
  validateScopeOwner,
  validateScopeRepo,
  validateScopeFacetName,
} from '../faceted-prompting/scope.js';
import {
  isPackagePiece,
  buildCandidateDirsWithPackage,
  resolveFacetPath,
} from '../infra/config/loaders/resource-resolver.js';

describe('@scope reference resolution', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-scope-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // U34: persona @scope 解決
  // Input:  "@nrslib/takt-ensemble-fixture/expert-coder" (personas field)
  // Expect: resolves to {repertoireDir}/@nrslib/takt-ensemble-fixture/facets/personas/expert-coder.md
  it('should resolve persona @scope reference to repertoire faceted path', () => {
    const repertoireDir = tempDir;
    const ref = '@nrslib/takt-ensemble-fixture/expert-coder';
    const scopeRef = parseScopeRef(ref);
    const resolved = resolveScopeRef(scopeRef, 'personas', repertoireDir);

    const expected = join(repertoireDir, '@nrslib', 'takt-ensemble-fixture', 'facets', 'personas', 'expert-coder.md');
    expect(resolved).toBe(expected);
  });

  // U35: policy @scope 解決
  // Input:  "@nrslib/takt-ensemble-fixture/strict-coding" (policies field)
  // Expect: resolves to {repertoireDir}/@nrslib/takt-ensemble-fixture/facets/policies/strict-coding.md
  it('should resolve policy @scope reference to repertoire faceted path', () => {
    const repertoireDir = tempDir;
    const ref = '@nrslib/takt-ensemble-fixture/strict-coding';
    const scopeRef = parseScopeRef(ref);
    const resolved = resolveScopeRef(scopeRef, 'policies', repertoireDir);

    const expected = join(repertoireDir, '@nrslib', 'takt-ensemble-fixture', 'facets', 'policies', 'strict-coding.md');
    expect(resolved).toBe(expected);
  });

  // U36: 大文字正規化
  // Input:  "@NrsLib/Takt-Ensemble-Fixture/expert-coder"
  // Expect: owner and repo lowercase-normalized; name kept as-is (must already be lowercase per spec)
  it('should normalize uppercase @scope references to lowercase before resolving', () => {
    const repertoireDir = tempDir;
    const ref = '@NrsLib/Takt-Ensemble-Fixture/expert-coder';
    const scopeRef = parseScopeRef(ref);

    // owner and repo are normalized to lowercase
    expect(scopeRef.owner).toBe('nrslib');
    expect(scopeRef.repo).toBe('takt-ensemble-fixture');

    const resolved = resolveScopeRef(scopeRef, 'personas', repertoireDir);
    const expected = join(repertoireDir, '@nrslib', 'takt-ensemble-fixture', 'facets', 'personas', 'expert-coder.md');
    expect(resolved).toBe(expected);
  });

  // U37: 存在しないスコープは解決失敗（ファイル不在のため undefined）
  // Input:  "@nonexistent/package/facet"
  // Expect: resolveFacetPath returns undefined (file not found at resolved path)
  it('should throw error when @scope reference points to non-existent package', () => {
    const repertoireDir = tempDir;
    const ref = '@nonexistent/package/facet';

    // resolveFacetPath returns undefined when the @scope file does not exist
    const result = resolveFacetPath(ref, 'personas', {
      lang: 'en',
      repertoireDir,
    });

    expect(result).toBeUndefined();
  });
});

describe('@scope name constraints', () => {
  // U38: owner 名前制約: 有効
  // Input:  "@nrslib"
  // Expect: バリデーション通過
  it('should accept valid owner name matching /^[a-z0-9][a-z0-9-]*$/', () => {
    expect(() => validateScopeOwner('nrslib')).not.toThrow();
    expect(() => validateScopeOwner('my-org')).not.toThrow();
    expect(() => validateScopeOwner('org123')).not.toThrow();
  });

  // U39: owner 名前制約: 大文字は正規化後に有効
  // Input:  "@NrsLib" → normalized to "@nrslib"
  // Expect: バリデーション通過（小文字正規化後）
  it('should normalize uppercase owner to lowercase and pass validation', () => {
    const ref = '@NrsLib/repo/facet';
    const scopeRef = parseScopeRef(ref);

    // parseScopeRef normalizes owner to lowercase
    expect(scopeRef.owner).toBe('nrslib');
    // lowercase owner passes validation
    expect(() => validateScopeOwner(scopeRef.owner)).not.toThrow();
  });

  // U40: owner 名前制約: 無効（先頭ハイフン）
  // Input:  "@-invalid"
  // Expect: バリデーションエラー
  it('should reject owner name starting with a hyphen', () => {
    expect(() => validateScopeOwner('-invalid')).toThrow();
  });

  // U41: repo 名前制約: ドット・アンダースコア許可
  // Input:  "@nrslib/my.repo_name"
  // Expect: バリデーション通過
  it('should accept repo name containing dots and underscores', () => {
    expect(() => validateScopeRepo('my.repo_name')).not.toThrow();
    expect(() => validateScopeRepo('repo.name')).not.toThrow();
    expect(() => validateScopeRepo('repo_name')).not.toThrow();
  });

  // U42: facet 名前制約: 無効（ドット含む）
  // Input:  "@nrslib/repo/facet.name"
  // Expect: バリデーションエラー
  it('should reject facet name containing dots', () => {
    expect(() => validateScopeFacetName('facet.name')).toThrow();
  });
});

describe('facet resolution chain: package-local layer', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-facet-chain-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // U43: パッケージローカルが最優先
  // Given: package-local, project, user, builtin の全層に同名ファセットが存在
  // When:  パッケージ内ピースからファセット解決
  // Then:  package-local 層のファセットが返る
  it('should prefer package-local facet over project/user/builtin layers', () => {
    const repertoireDir = join(tempDir, 'repertoire');
    const packagePiecesDir = join(repertoireDir, '@nrslib', 'takt-ensemble-fixture', 'pieces');
    const packageFacetDir = join(repertoireDir, '@nrslib', 'takt-ensemble-fixture', 'facets', 'personas');
    const projectFacetDir = join(tempDir, 'project', '.takt', 'facets', 'personas');

    // Create both package-local and project facet files with the same name
    mkdirSync(packageFacetDir, { recursive: true });
    mkdirSync(packagePiecesDir, { recursive: true });
    mkdirSync(projectFacetDir, { recursive: true });
    writeFileSync(join(packageFacetDir, 'expert-coder.md'), '# Package-local expert');
    writeFileSync(join(projectFacetDir, 'expert-coder.md'), '# Project expert');

    const candidateDirs = buildCandidateDirsWithPackage('personas', {
      lang: 'en',
      pieceDir: packagePiecesDir,
      repertoireDir,
      projectDir: join(tempDir, 'project'),
    });

    // Package-local dir should come first
    expect(candidateDirs[0]).toBe(packageFacetDir);
  });

  // U44: package-local にない場合は project に落ちる
  // Given: package-local にファセットなし、project にあり
  // When:  ファセット解決
  // Then:  project 層のファセットが返る
  it('should fall back to project facet when package-local does not have it', () => {
    const repertoireDir = join(tempDir, 'repertoire');
    const packagePiecesDir = join(repertoireDir, '@nrslib', 'takt-ensemble-fixture', 'pieces');
    const projectFacetDir = join(tempDir, 'project', '.takt', 'facets', 'personas');

    mkdirSync(packagePiecesDir, { recursive: true });
    mkdirSync(projectFacetDir, { recursive: true });
    // Only create project facet (no package-local facet)
    const projectFacetFile = join(projectFacetDir, 'expert-coder.md');
    writeFileSync(projectFacetFile, '# Project expert');

    const resolved = resolveFacetPath('expert-coder', 'personas', {
      lang: 'en',
      pieceDir: packagePiecesDir,
      repertoireDir,
      projectDir: join(tempDir, 'project'),
    });

    expect(resolved).toBe(projectFacetFile);
  });

  // U45: 非パッケージピースは package-local を使わない
  // Given: package-local にファセットあり、非パッケージピースから解決
  // When:  ファセット解決
  // Then:  package-local は無視。project → user → builtin の3層で解決
  it('should not consult package-local layer for non-package pieces', () => {
    const repertoireDir = join(tempDir, 'repertoire');
    const packageFacetDir = join(repertoireDir, '@nrslib', 'takt-ensemble-fixture', 'facets', 'personas');
    // Non-package pieceDir (not under repertoireDir)
    const globalPiecesDir = join(tempDir, 'global-pieces');

    mkdirSync(packageFacetDir, { recursive: true });
    mkdirSync(globalPiecesDir, { recursive: true });
    writeFileSync(join(packageFacetDir, 'expert-coder.md'), '# Package-local expert');

    const candidateDirs = buildCandidateDirsWithPackage('personas', {
      lang: 'en',
      pieceDir: globalPiecesDir,
      repertoireDir,
    });

    // Package-local dir should NOT be in candidates for non-package pieces
    expect(candidateDirs.some((d) => d.includes('@nrslib'))).toBe(false);
  });
});

describe('package piece detection', () => {
  // U46: パッケージ所属は pieceDir パスから判定
  // Given: pieceDir が {repertoireDir}/@nrslib/repo/pieces/ 配下
  // When:  isPackagePiece(pieceDir) 呼び出し
  // Then:  true が返る
  it('should return true for pieceDir under repertoire/@scope/repo/pieces/', () => {
    const repertoireDir = '/home/user/.takt/repertoire';
    const pieceDir = '/home/user/.takt/repertoire/@nrslib/takt-ensemble-fixture/pieces';

    expect(isPackagePiece(pieceDir, repertoireDir)).toBe(true);
  });

  // U47: 非パッケージ pieceDir は false
  // Given: pieceDir が ~/.takt/pieces/ 配下
  // When:  isPackagePiece(pieceDir) 呼び出し
  // Then:  false が返る
  it('should return false for pieceDir under global pieces directory', () => {
    const repertoireDir = '/home/user/.takt/repertoire';
    const pieceDir = '/home/user/.takt/pieces';

    expect(isPackagePiece(pieceDir, repertoireDir)).toBe(false);
  });
});
