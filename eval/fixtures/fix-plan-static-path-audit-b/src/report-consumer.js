import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function orderReportContracts(outputContracts) {
  return [...outputContracts.report].sort((left, right) => left.order - right.order);
}

export function expandReportTemplate(config, source) {
  const templatePath = config.arpeggio.template
    .replace('{report_id}', source.report_id);
  const body = [
    `# ${source.report_id}`,
    ...source.entries.map((entry) => `- ${entry}`),
  ].join('\n');
  return { templatePath, body };
}

export function mergeReportFile(projectRoot, config, rendered) {
  const mergePath = resolve(projectRoot, config.arpeggio.merge.file);
  mkdirSync(dirname(mergePath), { recursive: true });
  writeFileSync(mergePath, rendered.body);
  return mergePath;
}
