/**
 * faceted-prompting — Public API
 *
 * Re-exports all public types, interfaces, and functions.
 * Consumers should import from this module only.
 */

// Types
export type {
  FacetKind,
  FacetContent,
  FacetSet,
  ComposedPrompt,
  ComposeOptions,
} from './types.js';

// Compose
export { compose } from './compose.js';

// DataEngine
export type { DataEngine } from './data-engine.js';
export { FileDataEngine, CompositeDataEngine } from './data-engine.js';

// Truncation
export {
  trimContextContent,
  renderConflictNotice,
  prepareKnowledgeContent,
  preparePolicyContent,
} from './truncation.js';

// Template engine
export { renderTemplate } from './template.js';

// Escape
export { escapeTemplateChars } from './escape.js';

// Resolve
export type { PieceSections } from './resolve.js';
export {
  isResourcePath,
  resolveFacetPath,
  resolveFacetByName,
  resolveResourcePath,
  resolveResourceContent,
  resolveRefToContent,
  resolveRefList,
  resolveSectionMap,
  extractPersonaDisplayName,
  resolvePersona,
} from './resolve.js';

// Scope reference resolution
export type { ScopeRef } from './scope.js';
export {
  isScopeRef,
  parseScopeRef,
  resolveScopeRef,
  validateScopeOwner,
  validateScopeRepo,
  validateScopeFacetName,
} from './scope.js';
