import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalFacetDir, getProjectFacetDir } from '../infra/config/paths.js';
import {
  resolveRefList,
  resolveRefListWithSource,
  type FacetResolutionContext,
} from '../infra/config/loaders/resource-resolver.js';

describe.each(['policies', 'knowledge'] as const)('%s content deduplication', (facetType) => {
  let projectDir: string;
  let context: FacetResolutionContext;

  beforeEach(() => {
    projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'takt-facet-content-')));
    context = { projectDir, lang: 'ja' };
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeFacet(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  it.each(['include', 'extends'] as const)(
    'should deduplicate equal content after %s expansion across files and inline definitions',
    (directive) => {
      const facetsDir = getProjectFacetDir(projectDir, facetType);
      const firstPath = join(facetsDir, 'first.md');
      const secondPath = join(facetsDir, 'second.md');
      const sharedContent = 'SHARED';
      const body = directive === 'include'
        ? `{{include:${facetType}/shared}}`
        : '{extends: shared}';
      const dependencyPath = directive === 'include'
        ? join(dirname(facetsDir), 'partials', facetType, 'shared.md')
        : join(facetsDir, 'shared.md');
      writeFacet(dependencyPath, sharedContent);
      writeFacet(firstPath, body);
      writeFacet(secondPath, sharedContent);
      const definitions = { inlineA: sharedContent, inlineB: sharedContent, unique: 'UNIQUE' };
      const refs = [firstPath, 'unique', secondPath, 'inlineA', 'inlineB', firstPath];

      const resolved = resolveRefListWithSource(refs, definitions, projectDir, facetType, context);

      expect(resolved?.map(({ content }) => content)).toEqual([sharedContent, 'UNIQUE']);
      expect(resolved?.[0]).toMatchObject({ sourcePath: firstPath, refName: firstPath });
      expect(resolveRefList(refs, definitions, projectDir, facetType, context))
        .toEqual([sharedContent, 'UNIQUE']);
      expect(resolveRefList(['inlineA', 'inlineB', secondPath], definitions, projectDir, facetType, context))
        .toEqual([sharedContent]);
    },
  );

  describe.each(['include', 'extends'] as const)('%s resolution by source layer', (directive) => {
    it.each([false, true])(
      'should keep distinct expanded content for the same real path (global first: %s)',
      (globalFirst) => {
        const projectFacetsDir = getProjectFacetDir(projectDir, facetType);
        const globalFacetsDir = getGlobalFacetDir(facetType);
        const projectPath = join(projectFacetsDir, 'layered.md');
        const globalPath = join(globalFacetsDir, 'layered.md');
        const body = directive === 'include'
          ? `{{include:${facetType}/shared}}`
          : '{extends: shared}';
        for (const [facetsDir, content] of [
          [projectFacetsDir, 'PROJECT'],
          [globalFacetsDir, 'GLOBAL'],
        ] as const) {
          const dependencyPath = directive === 'include'
            ? join(dirname(facetsDir), 'partials', facetType, 'shared.md')
            : join(facetsDir, 'shared.md');
          writeFacet(dependencyPath, content);
        }
        writeFacet(projectPath, body);
        mkdirSync(globalFacetsDir, { recursive: true });
        symlinkSync(projectPath, globalPath);
        expect(realpathSync(globalPath)).toBe(realpathSync(projectPath));
        const paths = globalFirst ? [globalPath, projectPath] : [projectPath, globalPath];
        const expected = globalFirst ? ['GLOBAL', 'PROJECT'] : ['PROJECT', 'GLOBAL'];
        const refs = [...paths, ...paths];

        const resolved = resolveRefListWithSource(refs, undefined, projectDir, facetType, context);

        expect(resolved?.map(({ content }) => content)).toEqual(expected);
        expect(resolved?.map(({ sourcePath }) => sourcePath)).toEqual(paths);
        expect(resolveRefList(refs, undefined, projectDir, facetType, context)).toEqual(expected);
      },
    );
  });
});
