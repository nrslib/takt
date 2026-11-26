import type { ConfigEntry } from '@opencode/client';
import type { Config as V1Config } from '@opencode-ai/sdk/v2/types';
import { loadTemplate } from '../../shared/prompts/index.js';
import { buildOpenCodeV2ExternalDirectoryRules } from './external-directories.js';
import { parseProviderModel } from '../../shared/utils/providerModel.js';

type V2Config = Extract<ConfigEntry, { type: 'document' }>['info'];

export function buildV2ServerConfig(
  model: string | undefined,
  apiKey: string | undefined,
  plugin: string,
  mcp: Record<string, unknown> | undefined,
  skillsEnabled = false,
  externalDirectoryAllowlist?: readonly string[],
  contextWindow?: number,
  workspaceAccess?: import('../providers/types.js').OpenCodeWorkspaceAccess,
  readonlyDirectories?: readonly string[],
): V2Config {
  const contextModel = model !== undefined && contextWindow !== undefined
    ? parseProviderModel(model, 'OpenCode model')
    : undefined;
  const providers: NonNullable<V2Config['providers']> = {
    ...(apiKey === undefined ? {} : { opencode: { settings: { apiKey } } }),
  };
  if (contextModel !== undefined) {
    providers[contextModel.providerID] = {
      ...providers[contextModel.providerID],
      models: { [contextModel.modelID]: { limit: { context: contextWindow } } },
    };
  }
  const servers: NonNullable<NonNullable<V2Config['mcp']>['servers']> = {};
  for (const [name, config] of Object.entries((mcp ?? {}) as NonNullable<V1Config['mcp']>)) {
    if (!('type' in config)) throw new Error('OpenCode v2 MCP server must declare a transport');
    const common = {
      disabled: config.enabled === false, codemode: false,
      ...(config.timeout === undefined ? {} : { timeout: { startup: config.timeout, catalog: config.timeout, execution: config.timeout } }),
    };
    servers[name] = config.type === 'local'
      ? { ...common, type: 'local', command: config.command, environment: config.environment }
      : { ...common, type: 'remote', url: config.url, headers: config.headers, oauth: config.oauth === false ? false : config.oauth === undefined ? undefined : {
        client_id: config.oauth.clientId, client_secret: config.oauth.clientSecret, scope: config.oauth.scope,
        callback_port: config.oauth.callbackPort, redirect_uri: config.oauth.redirectUri,
      } };
  }
  const agent = (template: string): NonNullable<V2Config['agents']>[string] => ({
    system: loadTemplate(template, 'en', { listFilesMethod: 'uses read on a directory to list files' }).replace(/\bbash\b/gi, 'shell'),
    permissions: [
      { action: 'subagent', resource: '*', effect: 'deny' },
      ...(skillsEnabled ? [] : [{ action: 'skill', resource: '*', effect: 'deny' as const }]),
    ],
  });
  return {
    ...(model === undefined ? {} : { model }),
    plugins: [plugin],
    permissions: buildOpenCodeV2ExternalDirectoryRules(externalDirectoryAllowlist, workspaceAccess?.directories, readonlyDirectories),
    agents: { takt: agent('opencode_agent_prompt'), 'takt-review': agent('opencode_review_agent_prompt'), 'takt-report': agent('opencode_report_agent_prompt'), 'takt-read': agent('opencode_read_agent_prompt') },
    ...(Object.keys(providers).length === 0 ? {} : { providers }),
    ...(mcp === undefined ? {} : { mcp: { servers } }),
  };
}
