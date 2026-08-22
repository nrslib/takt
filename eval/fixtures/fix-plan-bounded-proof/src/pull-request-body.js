export function renderPullRequestBody(reportSummary) {
  return [
    '# Failed task evidence',
    JSON.stringify(reportSummary),
  ].join('\n\n');
}
