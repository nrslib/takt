import { basename, join } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import {
  getGlobalConfigDir,
  getProjectConfigDir,
} from '../../../infra/config/index.js';
import { getResourcesDir } from '../../../infra/resources/index.js';
import type { SelectOptionItem } from '../../../shared/prompt/index.js';
import {
  assertBuilderRootIsNotSymlink,
  listWorkflowFiles,
} from './files.js';
import type {
  BuilderScopeKind,
  BuilderWorkflowChoice,
  ResolvedBuilderScope,
} from './types.js';

export function buildBuilderScopeChoices(projectDir: string): SelectOptionItem<BuilderScopeKind>[] {
  const choices: SelectOptionItem<BuilderScopeKind>[] = [
    { label: 'Project .takt/', value: 'project' },
    { label: 'Global ~/.takt/', value: 'global' },
  ];
  if (isTaktRepositoryBuiltinScope(projectDir)) {
    choices.push({ label: 'TAKT builtins/en + builtins/ja', value: 'builtins' });
  }
  return choices;
}

export function resolveBuilderScope(options: {
  projectDir: string;
  scope: BuilderScopeKind;
}): ResolvedBuilderScope {
  switch (options.scope) {
    case 'project':
      return {
        kind: 'project',
        projectDir: options.projectDir,
        roots: [{ rootDir: getProjectConfigDir(options.projectDir) }],
        writeMode: 'single-language',
      };
    case 'global':
      return {
        kind: 'global',
        projectDir: options.projectDir,
        roots: [{ rootDir: getGlobalConfigDir() }],
        writeMode: 'single-language',
      };
    case 'builtins': {
      if (!isTaktRepositoryBuiltinScope(options.projectDir)) {
        throw new Error('Builtin workflow builder scope is available only inside the TAKT repository.');
      }
      return {
        kind: 'builtins',
        projectDir: options.projectDir,
        roots: [
          { lang: 'en', rootDir: join(options.projectDir, 'builtins', 'en') },
          { lang: 'ja', rootDir: join(options.projectDir, 'builtins', 'ja') },
        ],
        writeMode: 'dual-language',
      };
    }
  }
}

export function listBuilderTargetWorkflows(scope: ResolvedBuilderScope): BuilderWorkflowChoice[] {
  return scope.roots
    .flatMap((root) => {
      assertBuilderRootIsNotSymlink(root.rootDir);
      return listWorkflowFiles(join(root.rootDir, 'workflows')).map((path) => ({
        name: basename(path).replace(/\.ya?ml$/i, ''),
        path,
        ...(root.lang ? { lang: root.lang } : {}),
      }));
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

function isTaktRepositoryBuiltinScope(projectDir: string): boolean {
  const projectBuiltinsDir = join(projectDir, 'builtins');
  return existsSync(join(projectBuiltinsDir, 'ja', 'STYLE_GUIDE.md'))
    && existsSync(join(projectBuiltinsDir, 'en'))
    && existsSync(projectBuiltinsDir)
    && existsSync(getResourcesDir())
    && realpathSync(projectBuiltinsDir) === realpathSync(getResourcesDir());
}
