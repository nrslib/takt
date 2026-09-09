export default function buildReportHandoffInput({ vars }) {
  return JSON.stringify({
    language: vars.language ?? 'ja',
    workflow: vars.workflow ?? 'development-implement-dynamic',
    task: vars.task,
    reports: vars.reports,
    workResult: vars.work_result,
  });
}
