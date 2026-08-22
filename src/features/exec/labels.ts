import type { Language } from '../../core/models/types.js';
import { getLabel } from '../../shared/i18n/index.js';
import type { FacetType } from '../catalog/catalogFacets.js';
import type { ExecPresetScope } from './types.js';

export type ExecLanguage = Extract<Language, 'en' | 'ja'>;
export type LocalizedExecScope = ExecPresetScope | 'default' | 'project' | 'global';

export function execLabel(lang: ExecLanguage, key: string, vars?: Record<string, string>): string {
  return getLabel(`exec.${key}`, lang, vars);
}

export function execCurrentLabel(lang: ExecLanguage, value: string): string {
  return `${value} ${execLabel(lang, 'common.currentSuffix')}`;
}

export function execScopeLabel(lang: ExecLanguage, scope: LocalizedExecScope): string {
  return execLabel(lang, `common.${scope}`);
}

export function execSourceLabel(lang: ExecLanguage, source: string): string {
  if (source === 'builtin' || source === 'project' || source === 'global' || source === 'user') {
    return execLabel(lang, `common.${source}`);
  }
  return source;
}

export function execFacetKindLabel(lang: ExecLanguage, kind: FacetType): string {
  return execLabel(lang, `facets.${kind}`);
}
