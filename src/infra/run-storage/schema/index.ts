import { CORE_DDL } from './core.js';
import { EXECUTION_DDL } from './execution.js';
import { FINDINGS_DDL } from './findings.js';
import { OPERATIONS_DDL } from './operations.js';
import { REPORTS_DDL } from './reports.js';
import { TERMINAL_SEAL_DDL } from './terminal-seal.js';

export const RUN_STORAGE_DDL = Object.freeze([
  ...CORE_DDL,
  ...EXECUTION_DDL,
  ...OPERATIONS_DDL,
  ...REPORTS_DDL,
  ...FINDINGS_DDL,
  ...TERMINAL_SEAL_DDL,
]);
