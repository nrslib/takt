/**
 * Project configuration - barrel exports
 */

export {
  loadProjectConfig,
  saveProjectConfig,
  updateProjectConfig,
  getCurrentPiece,
  setCurrentPiece,
  isVerboseMode,
  type PermissionMode,
  type ProjectLocalConfig,
} from './projectConfig.js';

export {
  writeFileAtomic,
  getInputHistoryPath,
  MAX_INPUT_HISTORY,
  loadInputHistory,
  saveInputHistory,
  addToInputHistory,
  type AgentSessionData,
  getAgentSessionsPath,
  loadAgentSessions,
  saveAgentSessions,
  updateAgentSession,
  clearAgentSessions,
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
