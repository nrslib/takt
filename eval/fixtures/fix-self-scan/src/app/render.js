import { legacyFormatLine, formatSourceLine } from '../core/format.js';
import { buildRunSummary } from '../core/summary.js';

// Renders the run summary for the terminal.
export function renderSummary(config, entries) {
  const summary = buildRunSummary(config, entries);
  const lines = [legacyFormatLine([summary.provider, summary.model])];
  for (const source of summary.sources) {
    lines.push(formatSourceLine(source.key, source.label));
  }
  return lines.join('\n');
}
