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
  validateMcpSectionReferences,
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
  /** Deterministic identity including non-secret server structure. */
  identity: string;
}

function collectAdditions(
  additions: Set<string>,
  list: readonly string[] | undefined,
): void {
  if (list === undefined) {
    return;
  }
  for (const name of list) {
    additions.add(name);
  }
}

function collectExcludes(
  excludes: Set<string>,
  list: readonly string[] | undefined,
): void {
  if (list === undefined) {
    return;
  }
  for (const name of list) {
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
  validateMcpSectionReferences(section);
  const additions = new Set<string>();
  const excludes = new Set<string>();

  // defaults.servers apply to every agent execution (order.md:106).
  collectAdditions(
    additions,
    section.defaults?.servers,
  );

  // personas/tags/steps add on top of defaults.
  const personaTarget = matchPersonaTarget(section, context);
  collectAdditions(
    additions,
    personaTarget?.servers,
  );
  collectExcludes(
    excludes,
    personaTarget?.exclude,
  );

  for (const tagTarget of matchTagTargets(section, context)) {
    collectAdditions(additions, tagTarget.servers);
    collectExcludes(excludes, tagTarget.exclude);
  }

  const stepTarget = matchStepTarget(section, context);
  collectAdditions(
    additions,
    stepTarget?.servers,
  );
  collectExcludes(
    excludes,
    stepTarget?.exclude,
  );

  // internal_agents.selector.exclude applies a common exclude to internal agents.
  const internalExclude = matchInternalAgentsExclude(section, context);
  collectExcludes(
    excludes,
    internalExclude,
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
  const serverDefinitions = section.servers ?? {};
  for (const name of serverNames) {
    // validateMcpSectionReferences above guarantees every effective name is defined.
    resolvedServers[name] = interpolateMcpEnv(serverDefinitions[name]!);
  }

  return {
    enabled: true,
    servers: resolvedServers,
    serverNames,
    identity: buildMcpServerSetIdentity(resolvedServers),
  };
}

/**
 * Resolve the shared MCP assignment for a TAKT-owned internal agent.
 *
 * Internal agents do not have a workflow persona, tag, or step target. They
 * still receive `defaults.servers`, and the common internal-agent exclusion
 * is applied with `isInternalAgent: true`.
 */
export interface ResolvedInternalAgentMcpServers {
  servers: Record<string, McpServerConfig>;
  identity: string | undefined;
}

export function resolveInternalAgentMcpServers(
  section: McpAssignmentSection | undefined,
): ResolvedInternalAgentMcpServers {
  if (section === undefined) {
    return { servers: {}, identity: undefined };
  }

  const resolved = resolveMcpAssignment(section, {
    persona: undefined,
    tags: [],
    stepQualifiedName: undefined,
    isWorkflowCallNode: false,
    isInternalAgent: true,
  });
  if (!resolved.enabled) {
    return { servers: {}, identity: undefined };
  }
  return { servers: resolved.servers, identity: resolved.identity };
}
