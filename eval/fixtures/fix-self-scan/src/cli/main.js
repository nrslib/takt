import { parseProviderFlags } from '../app/flags.js';
import { initSession } from '../app/session.js';
import { renderSummary } from '../app/render.js';
import { collectDiagnostics } from '../app/diagnostics.js';

// Wires the CLI surface: parse flags, open the session, render the summary.
export function runCli(config, argv, entries, env = {}) {
  const flags = parseProviderFlags(argv);
  const session = initSession(config, flags, env);
  return {
    session,
    summaryText: renderSummary(config, entries),
    diagnostics: collectDiagnostics(config, entries),
  };
}
