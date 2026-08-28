import { schema } from './schema.js';
import { loadReportInput } from './loader.js';
import {
  expandReportTemplate,
  mergeReportFile,
  orderReportContracts,
} from './report-consumer.js';

export function buildReportArtifact(projectRoot, config = schema) {
  const loaded = loadReportInput(projectRoot, config);
  const rendered = expandReportTemplate(config, loaded.source);
  const mergePath = mergeReportFile(projectRoot, config, rendered);

  return {
    sourcePath: loaded.sourcePath,
    orderedReports: orderReportContracts(config.output_contracts),
    templatePath: rendered.templatePath,
    mergeFile: mergePath,
    terminal: 'merged report file',
  };
}
