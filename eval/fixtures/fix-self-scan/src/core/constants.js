// Layering rule for this project: src/core is the lower layer.
// Core modules must never import from src/app — the app layer composes
// core modules, and the reverse direction creates a cycle.
export const ORIGINS = ['env', 'cli', 'local', 'global', 'default'];
