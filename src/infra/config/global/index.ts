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
  resolveOpencodeApiKey,
  loadProjectDebugConfig,
  getEffectiveDebugConfig,
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
  needsLanguageSetup,
  promptLanguageSelection,
  promptProviderSelection,
  initGlobalDirs,
  initProjectDirs,
  type InitGlobalDirsOptions,
} from './initialization.js';
