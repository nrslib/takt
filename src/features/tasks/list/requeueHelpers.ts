import { confirm } from '../../../shared/prompt/index.js';
import { getLabel } from '../../../shared/i18n/index.js';
import {
  selectRun,
  loadRunSessionContext,
  listRecentRuns,
  type RunSessionContext,
} from '../../interactive/index.js';

export function appendRetryNote(existing: string | undefined, additional: string): string {
  const trimmedAdditional = additional.trim();
  if (trimmedAdditional === '') {
    throw new Error('Additional instruction is empty.');
  }
  if (!existing || existing.trim() === '') {
    return trimmedAdditional;
  }
  return `${existing}\n\n${trimmedAdditional}`;
}

export async function selectRunSessionContext(
  projectDir: string,
  lang: 'en' | 'ja',
): Promise<RunSessionContext | undefined> {
  if (listRecentRuns(projectDir).length === 0) {
    return undefined;
  }

  const shouldReferenceRun = await confirm(
    getLabel('interactive.runSelector.confirm', lang),
    false,
  );
  if (!shouldReferenceRun) {
    return undefined;
  }

  const selectedSlug = await selectRun(projectDir, lang);
  if (!selectedSlug) {
    return undefined;
  }

  return loadRunSessionContext(projectDir, selectedSlug);
}
