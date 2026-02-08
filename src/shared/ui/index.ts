/**
 * UI utilities for terminal output — re-export hub.
 *
 * All implementations have been split into dedicated files:
 * - LogManager.ts: Log level management and formatted output
 * - Spinner.ts: Animated terminal spinner
 * - StreamDisplay.ts: Real-time stream display for Claude/Codex output
 */

export {
  LogManager,
  type LogLevel,
  setLogLevel,
  blankLine,
  debug,
  info,
  warn,
  error,
  success,
  header,
  section,
  status,
  progressBar,
  list,
  divider,
  truncate,
} from './LogManager.js';

export { Spinner } from './Spinner.js';

export { StreamDisplay, type ProgressInfo } from './StreamDisplay.js';

export { TaskPrefixWriter } from './TaskPrefixWriter.js';
