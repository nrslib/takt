export function listRecentRuns(runs) {
  return runs.slice(0, 10);
}

export function findRunForTask(runs, taskText) {
  return listRecentRuns(runs).find((run) => run.taskText === taskText)?.slug ?? null;
}

export function findPreviousOrderContent(runs, runSlug) {
  const selected = runSlug
    ? runs.find((run) => run.slug === runSlug)
    : runs[0];
  return selected?.order ?? null;
}
