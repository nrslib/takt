/**
 * Global configuration - barrel exports
 */

export {
  GlobalConfigManager,
  invalidateGlobalConfigCache,
  loadGlobalConfig,
  saveGlobalConfig,
  getDisabledBuiltins,
  getBuiltinWorkflowsEnabled,
  getLanguage,
  setLanguage,
  setProvider,
  addTrustedDirectory,
  isDirectoryTrusted,
  resolveAnthropicApiKey,
  resolveOpenaiApiKey,
  loadProjectDebugConfig,
  getEffectiveDebugConfig,
} from './globalConfig.js';

export {
  getBookmarkedWorkflows,
  addBookmark,
  removeBookmark,
  isBookmarked,
} from './bookmarks.js';

export {
  getWorkflowCategoriesConfig,
  setWorkflowCategoriesConfig,
  getShowOthersCategory,
  setShowOthersCategory,
  getOthersCategoryName,
  setOthersCategoryName,
} from './workflowCategories.js';

export {
  needsLanguageSetup,
  promptLanguageSelection,
  promptProviderSelection,
  initGlobalDirs,
  initProjectDirs,
  type InitGlobalDirsOptions,
} from './initialization.js';
