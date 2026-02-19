/**
 * Project configuration - barrel exports
 */

export {
  loadProjectConfig,
  saveProjectConfig,
  updateProjectConfig,
  setCurrentPiece,
  type ProjectLocalConfig,
} from './projectConfig.js';
export {
  isVerboseMode,
} from './resolvedSettings.js';

export {
  writeFileAtomic,
  getInputHistoryPath,
  MAX_INPUT_HISTORY,
  loadInputHistory,
  saveInputHistory,
  addToInputHistory,
  type PersonaSessionData,
  getPersonaSessionsPath,
  loadPersonaSessions,
  savePersonaSessions,
  updatePersonaSession,
  clearPersonaSessions,
  getWorktreeSessionsDir,
  encodeWorktreePath,
  getWorktreeSessionPath,
  loadWorktreeSessions,
  updateWorktreeSession,
  getClaudeProjectSessionsDir,
  clearClaudeProjectSessions,
} from './sessionStore.js';

export {
  type SessionState,
  getSessionStatePath,
  loadSessionState,
  saveSessionState,
  clearSessionState,
} from './sessionState.js';
