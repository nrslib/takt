/**
 * Global configuration - barrel exports
 */

export {
  GlobalConfigManager,
  invalidateGlobalConfigCache,
  loadGlobalConfig,
  saveGlobalConfig,
  getDisabledBuiltins,
  getBuiltinPiecesEnabled,
  getLanguage,
  setLanguage,
  setProvider,
  resolveAnthropicApiKey,
  resolveOpenaiApiKey,
  resolveCodexCliPath,
  resolveClaudeCliPath,
  resolveCursorCliPath,
  resolveOpencodeApiKey,
  resolveCursorApiKey,
  validateCliPath,
} from './globalConfig.js';

export {
  getBookmarkedPieces,
  addBookmark,
  removeBookmark,
  isBookmarked,
} from './bookmarks.js';

export {
  getPieceCategoriesPath,
  resetPieceCategories,
} from './pieceCategories.js';

export {
  resetGlobalConfigToTemplate,
  type ResetGlobalConfigResult,
} from './resetConfig.js';

export {
  needsLanguageSetup,
  promptLanguageSelection,
  promptProviderSelection,
  initGlobalDirs,
  initProjectDirs,
  type InitGlobalDirsOptions,
} from './initialization.js';
