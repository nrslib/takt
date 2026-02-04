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
  getPieceCategoriesConfig,
  setPieceCategoriesConfig,
  getShowOthersCategory,
  setShowOthersCategory,
  getOthersCategoryName,
  setOthersCategoryName,
} from './pieceCategories.js';

export {
  needsLanguageSetup,
  promptLanguageSelection,
  promptProviderSelection,
  initGlobalDirs,
  initProjectDirs,
  type InitGlobalDirsOptions,
} from './initialization.js';
