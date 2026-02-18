/**
 * Run selector for interactive mode
 *
 * Checks for recent runs and presents a selection UI
 * using the same selectOption pattern as sessionSelector.
 */

import { selectOption, type SelectOptionItem } from '../../shared/prompt/index.js';
import { getLabel } from '../../shared/i18n/index.js';
import { info } from '../../shared/ui/index.js';
import { listRecentRuns, type RunSummary } from './runSessionReader.js';
import { truncateForLabel, formatDateForSelector } from './selectorUtils.js';

/** Maximum label length for run task display */
const MAX_TASK_LABEL_LENGTH = 60;

/**
 * Prompt user to select a run from recent runs.
 *
 * @returns Selected run slug, or null if no runs or cancelled
 */
export async function selectRun(
  cwd: string,
  lang: 'en' | 'ja',
): Promise<string | null> {
  const runs = listRecentRuns(cwd);

  if (runs.length === 0) {
    info(getLabel('interactive.runSelector.noRuns', lang));
    return null;
  }

  const options: SelectOptionItem<string>[] = runs.map((run: RunSummary) => {
    const label = truncateForLabel(run.task, MAX_TASK_LABEL_LENGTH);
    const dateStr = formatDateForSelector(run.startTime, lang);
    const description = `${dateStr} | ${run.piece} | ${run.status}`;

    return {
      label,
      value: run.slug,
      description,
    };
  });

  const prompt = getLabel('interactive.runSelector.prompt', lang);
  const selected = await selectOption<string>(prompt, options);

  return selected;
}
