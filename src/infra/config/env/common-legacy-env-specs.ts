import type { LegacyEnvSpec } from './config-env-shared.js';

export const COMMON_LEGACY_ENV_SPECS: readonly LegacyEnvSpec[] = [
  {
    env: 'TAKT_INTERACTIVE_PREVIEW_MOVEMENTS',
    path: 'interactive_preview_movements',
    canonicalPath: 'interactive_preview_steps',
  },
  {
    env: 'TAKT_PIECE_RUNTIME_PREPARE',
    path: 'piece_runtime_prepare',
    canonicalPath: 'workflow_runtime_prepare',
  },
  {
    env: 'TAKT_PIECE_RUNTIME_PREPARE_CUSTOM_SCRIPTS',
    path: 'piece_runtime_prepare.custom_scripts',
    canonicalPath: 'workflow_runtime_prepare.custom_scripts',
  },
  {
    env: 'TAKT_PIECE_ARPEGGIO',
    path: 'piece_arpeggio',
    canonicalPath: 'workflow_arpeggio',
  },
  {
    env: 'TAKT_PIECE_ARPEGGIO_CUSTOM_DATA_SOURCE_MODULES',
    path: 'piece_arpeggio.custom_data_source_modules',
    canonicalPath: 'workflow_arpeggio.custom_data_source_modules',
  },
  {
    env: 'TAKT_PIECE_ARPEGGIO_CUSTOM_MERGE_INLINE_JS',
    path: 'piece_arpeggio.custom_merge_inline_js',
    canonicalPath: 'workflow_arpeggio.custom_merge_inline_js',
  },
  {
    env: 'TAKT_PIECE_ARPEGGIO_CUSTOM_MERGE_FILES',
    path: 'piece_arpeggio.custom_merge_files',
    canonicalPath: 'workflow_arpeggio.custom_merge_files',
  },
  {
    env: 'TAKT_PIECE_MCP_SERVERS',
    path: 'piece_mcp_servers',
    canonicalPath: 'workflow_mcp_servers',
  },
  {
    env: 'TAKT_PIECE_MCP_SERVERS_STDIO',
    path: 'piece_mcp_servers.stdio',
    canonicalPath: 'workflow_mcp_servers.stdio',
  },
  {
    env: 'TAKT_PIECE_MCP_SERVERS_SSE',
    path: 'piece_mcp_servers.sse',
    canonicalPath: 'workflow_mcp_servers.sse',
  },
  {
    env: 'TAKT_PIECE_MCP_SERVERS_HTTP',
    path: 'piece_mcp_servers.http',
    canonicalPath: 'workflow_mcp_servers.http',
  },
];
