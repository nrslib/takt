/**
 * MCP assignment resolution (issue #1137).
 *
 * Resolves the effective MCP server set for an agent execution from the
 * `runtime.yaml.mcp` section. The resolution rule is:
 *
 *   effective servers
 *     = defaults.servers
 *     + matched targets.servers
 *     - matched targets.exclude
 *
 * Server names are de-duplicated; `exclude` wins over `addition`; a target
 * referencing an unknown server name fails fast (order.md:93-105).
 *
 * This module owns the target resolution rule only. It does not know provider
 * config formats (that lives in `infra/providers/mcp/`), and it does not read
 * the runtime file — callers pass the already-loaded `mcp` section.
 */

import type { McpServerConfig } from '../../../core/models/index.js';
import {
  interpolateMcpEnv,
  buildMcpServerSetIdentity,
  type McpSection,
} from './mcp-schema.js';

/** The `mcp` section shape consumed by the resolver. */
export type McpAssignmentSection = McpSection;

/** Per-target entry shape shared by personas/tags/steps. */
export interface McpTargetAssignment {
  servers?: readonly string[];
  exclude?: readonly string[];
}

/** Context for resolving the effective MCP server set for one agent. */
export interface AgentExecutionContext {
  /** Persona name of the current agent step (undefined for control nodes). */
  persona: string | undefined;
  /** Workflow tags active for the current step. */
  tags: readonly string[];
  /** Fully-qualified step name `<leaf-workflow-name>/<step-name>`. */
  stepQualifiedName: string | undefined;
  /** True when the current node is a `workflow_call` control node (not an agent). */
  isWorkflowCallNode: boolean;
  /** True when resolving for an internal agent (selector/assistant). */
  isInternalAgent: boolean;
}

/** Resolved MCP server set ready to hand to a provider adapter. */
export interface ResolvedMcpServers {
  /** True when at least one server is assigned (MCP enabled). */
  enabled: boolean;
  /** Resolved (env-interpolated) server configs keyed by name. */
  servers: Record<string, McpServerConfig>;
  /** Sorted server names (effective set, de-duplicated). */
  serverNames: string[];
  /** Deterministic identity (server name + transport only, secrets excluded). */
  identity: string;
}

function assertKnownServer(
  serverName: string,
  known: ReadonlySet<string>,
  context: string,
): void {
  if (!known.has(serverName)) {
    throw new Error(
      `MCP target ${context} references unknown server "${serverName}". Defined servers: ${[...known].sort().join(', ') || '(none)'}`,
    );
  }
}

function collectAdditions(
  additions: Set<string>,
  list: readonly string[] | undefined,
  known: ReadonlySet<string>,
  context: string,
): void {
  if (list === undefined) {
    return;
  }
  for (const name of list) {
    assertKnownServer(name, known, context);
    additions.add(name);
  }
}

function collectExcludes(
  excludes: Set<string>,
  list: readonly string[] | undefined,
  known: ReadonlySet<string>,
  context: string,
): void {
  if (list === undefined) {
    return;
  }
  for (const name of list) {
    assertKnownServer(name, known, context);
    excludes.add(name);
  }
}

function matchPersonaTarget(
  section: McpAssignmentSection,
  context: AgentExecutionContext,
): McpTargetAssignment | undefined {
  const personas = section.targets?.personas;
  if (personas === undefined || context.persona === undefined) {
    return undefined;
  }
  return personas[context.persona];
}

function matchTagTargets(
  section: McpAssignmentSection,
  context: AgentExecutionContext,
): McpTargetAssignment[] {
  const tags = section.targets?.tags;
  if (tags === undefined || context.tags.length === 0) {
    return [];
  }
  const matched: McpTargetAssignment[] = [];
  for (const tag of context.tags) {
    const entry = tags[tag];
    if (entry !== undefined) {
      matched.push(entry);
    }
  }
  return matched;
}

function matchStepTarget(
  section: McpAssignmentSection,
  context: AgentExecutionContext,
): McpTargetAssignment | undefined {
  if (context.isWorkflowCallNode || context.stepQualifiedName === undefined) {
    return undefined;
  }
  return section.targets?.steps?.[context.stepQualifiedName];
}

function matchInternalAgentsExclude(
  section: McpAssignmentSection,
  context: AgentExecutionContext,
): readonly string[] | undefined {
  if (!context.isInternalAgent) {
    return undefined;
  }
  return section.targets?.internal_agents?.selector?.exclude;
}

/**
 * Resolve the effective MCP server set for a single agent execution.
 *
 * `exclude` is applied after collecting all additions so it always wins over
 * `defaults` and matched target `servers` (order.md:102). Unknown server names
 * in `defaults`, target `servers`, or `exclude` fail fast (order.md:104).
 */
export function resolveMcpAssignment(
  section: McpAssignmentSection,
  context: AgentExecutionContext,
): ResolvedMcpServers {
  const knownServers = new Set<string>(Object.keys(section.servers ?? {}));
  const additions = new Set<string>();
  const excludes = new Set<string>();

  // defaults.servers apply to every agent execution (order.md:106).
  collectAdditions(
    additions,
    section.defaults?.servers,
    knownServers,
    'defaults.servers',
  );

  // personas/tags/steps add on top of defaults.
  const personaTarget = matchPersonaTarget(section, context);
  collectAdditions(
    additions,
    personaTarget?.servers,
    knownServers,
    `personas.${context.persona ?? '(none)'}.servers`,
  );
  collectExcludes(
    excludes,
    personaTarget?.exclude,
    knownServers,
    `personas.${context.persona ?? '(none)'}.exclude`,
  );

  for (const tagTarget of matchTagTargets(section, context)) {
    collectAdditions(additions, tagTarget.servers, knownServers, 'tags.servers');
    collectExcludes(excludes, tagTarget.exclude, knownServers, 'tags.exclude');
  }

  const stepTarget = matchStepTarget(section, context);
  collectAdditions(
    additions,
    stepTarget?.servers,
    knownServers,
    `steps.${context.stepQualifiedName ?? '(none)'}.servers`,
  );
  collectExcludes(
    excludes,
    stepTarget?.exclude,
    knownServers,
    `steps.${context.stepQualifiedName ?? '(none)'}.exclude`,
  );

  // internal_agents.selector.exclude applies a common exclude to internal agents.
  const internalExclude = matchInternalAgentsExclude(section, context);
  collectExcludes(
    excludes,
    internalExclude,
    knownServers,
    'internal_agents.selector.exclude',
  );

  // exclude wins over addition (order.md:102).
  for (const name of excludes) {
    additions.delete(name);
  }

  const serverNames = [...additions].sort();
  if (serverNames.length === 0) {
    return {
      enabled: false,
      servers: {},
      serverNames: [],
      identity: '',
    };
  }

  const resolvedServers: Record<string, McpServerConfig> = {};
  for (const name of serverNames) {
    const raw = section.servers?.[name];
    if (raw === undefined) {
      // Unreachable: additions are validated against known servers above.
      throw new Error(`MCP server "${name}" is not defined in mcp.servers`);
    }
    resolvedServers[name] = interpolateMcpEnv(raw as McpServerConfig);
  }

  return {
    enabled: true,
    servers: resolvedServers,
    serverNames,
    identity: buildMcpServerSetIdentity(resolvedServers),
  };
}