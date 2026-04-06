function formatLegacyConfigKeyDeprecationMessage(
  legacyKey: string,
  canonicalKey: string,
  contextLabel?: string,
): string {
  let msg = `Deprecated: "${legacyKey}" is deprecated. Use "${canonicalKey}" instead.`;
  if (contextLabel !== undefined && contextLabel.length > 0) {
    msg = `${msg} (${contextLabel})`;
  }
  return msg;
}

const legacyConfigKeyDeprecationSeen = new Set<string>();

export function warnLegacyConfigKey(
  seen: Set<string>,
  legacyKey: string,
  canonicalKey: string,
  contextLabel?: string,
): void {
  const msg = formatLegacyConfigKeyDeprecationMessage(legacyKey, canonicalKey, contextLabel);
  if (seen.has(msg)) {
    return;
  }
  seen.add(msg);
  console.warn(msg);
}

export function warnLegacyConfigKeyOncePerProcess(
  legacyKey: string,
  canonicalKey: string,
  contextLabel?: string,
): void {
  warnLegacyConfigKey(legacyConfigKeyDeprecationSeen, legacyKey, canonicalKey, contextLabel);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function warnLegacyPieceStarYamlKeys(parsed: Record<string, unknown>, seen: Set<string>): void {
  if ('piece_overrides' in parsed) {
    warnLegacyConfigKey(seen, 'piece_overrides', 'workflow_overrides');
  }
  if ('piece_runtime_prepare' in parsed) {
    warnLegacyConfigKey(seen, 'piece_runtime_prepare', 'workflow_runtime_prepare');
  }
  if ('piece_arpeggio' in parsed) {
    warnLegacyConfigKey(seen, 'piece_arpeggio', 'workflow_arpeggio');
  }
  if ('piece_mcp_servers' in parsed) {
    warnLegacyConfigKey(seen, 'piece_mcp_servers', 'workflow_mcp_servers');
  }
}

function warnLegacyOverridesNestedMovements(overrides: unknown, blockLabel: string, seen: Set<string>): void {
  if (!isPlainRecord(overrides)) {
    return;
  }
  if ('movements' in overrides) {
    warnLegacyConfigKey(seen, 'movements', 'steps', blockLabel);
  }
}

export function warnLegacyGlobalConfigYamlKeys(parsed: Record<string, unknown>, seen: Set<string>): void {
  if ('enable_builtin_pieces' in parsed) {
    warnLegacyConfigKey(seen, 'enable_builtin_pieces', 'enable_builtin_workflows');
  }
  if ('piece_categories_file' in parsed) {
    warnLegacyConfigKey(seen, 'piece_categories_file', 'workflow_categories_file');
  }
  const nse = parsed.notification_sound_events;
  if (isPlainRecord(nse)) {
    if ('piece_complete' in nse) {
      warnLegacyConfigKey(seen, 'piece_complete', 'workflow_complete', 'notification_sound_events');
    }
    if ('piece_abort' in nse) {
      warnLegacyConfigKey(seen, 'piece_abort', 'workflow_abort', 'notification_sound_events');
    }
  }
  if ('interactive_preview_movements' in parsed) {
    warnLegacyConfigKey(seen, 'interactive_preview_movements', 'interactive_preview_steps');
  }
  warnLegacyPieceStarYamlKeys(parsed, seen);
  const po = parsed.piece_overrides;
  const wo = parsed.workflow_overrides;
  warnLegacyOverridesNestedMovements(po, 'piece_overrides', seen);
  warnLegacyOverridesNestedMovements(wo, 'workflow_overrides', seen);
}

export function warnLegacyGlobalConfigYamlKeysOncePerProcess(parsed: Record<string, unknown>): void {
  warnLegacyGlobalConfigYamlKeys(parsed, legacyConfigKeyDeprecationSeen);
}

export function warnLegacyProjectConfigYamlKeys(parsed: Record<string, unknown>, seen: Set<string>): void {
  warnLegacyPieceStarYamlKeys(parsed, seen);
  const po = parsed.piece_overrides;
  const wo = parsed.workflow_overrides;
  warnLegacyOverridesNestedMovements(po, 'piece_overrides', seen);
  warnLegacyOverridesNestedMovements(wo, 'workflow_overrides', seen);
  const profiles = parsed.provider_profiles;
  if (isPlainRecord(profiles)) {
    for (const prof of Object.values(profiles)) {
      if (!isPlainRecord(prof)) {
        continue;
      }
      if ('movement_permission_overrides' in prof) {
        warnLegacyConfigKey(seen, 'movement_permission_overrides', 'step_permission_overrides');
      }
    }
  }
}

export function warnLegacyProjectConfigYamlKeysOncePerProcess(parsed: Record<string, unknown>): void {
  warnLegacyProjectConfigYamlKeys(parsed, legacyConfigKeyDeprecationSeen);
}

function walkParallelSubStepsForStepAlias(
  movements: unknown,
  seen: Set<string>,
): void {
  if (!Array.isArray(movements)) {
    return;
  }
  for (const mov of movements) {
    if (!isPlainRecord(mov)) {
      continue;
    }
    const par = mov.parallel;
    if (!Array.isArray(par)) {
      continue;
    }
    for (const sub of par) {
      if (!isPlainRecord(sub)) {
        continue;
      }
      if ('step' in sub) {
        warnLegacyConfigKey(seen, 'step', 'name', 'parallel');
      }
    }
  }
}

export function warnLegacyWorkflowYamlKeys(raw: unknown, seen: Set<string>): void {
  if (!isPlainRecord(raw)) {
    return;
  }
  if ('piece_config' in raw) {
    warnLegacyConfigKey(seen, 'piece_config', 'workflow_config');
  }
  if ('max_movements' in raw) {
    warnLegacyConfigKey(seen, 'max_movements', 'max_steps');
  }
  const hasSteps = 'steps' in raw;
  const hasMovements = 'movements' in raw;
  if (hasMovements) {
    warnLegacyConfigKey(seen, 'movements', 'steps');
  }
  if ('initial_movement' in raw) {
    warnLegacyConfigKey(seen, 'initial_movement', 'initial_step');
  }
  if (hasMovements) {
    walkParallelSubStepsForStepAlias(raw.movements, seen);
  }
  if (hasSteps) {
    walkParallelSubStepsForStepAlias(raw.steps, seen);
  }
}

export function warnLegacyWorkflowYamlKeysOncePerProcess(raw: unknown): void {
  warnLegacyWorkflowYamlKeys(raw, legacyConfigKeyDeprecationSeen);
}

function walkCategoryNodesForLegacyPiecesKey(node: unknown, seen: Set<string>, path: string[]): void {
  if (!isPlainRecord(node)) {
    return;
  }
  if ('pieces' in node) {
    const label = path.length > 0 ? path.join(' > ') : 'category';
    warnLegacyConfigKey(seen, 'pieces', 'workflows', label);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'pieces' || key === 'workflows') {
      continue;
    }
    if (isPlainRecord(value)) {
      walkCategoryNodesForLegacyPiecesKey(value, seen, [...path, key]);
    }
  }
}

function walkCategoryRoot(root: unknown, seen: Set<string>): void {
  if (!isPlainRecord(root)) {
    return;
  }
  for (const name of Object.keys(root)) {
    const value = root[name];
    if (isPlainRecord(value)) {
      walkCategoryNodesForLegacyPiecesKey(value, seen, [name]);
    }
  }
}

export function warnLegacyCategoryYamlKeys(raw: unknown, seen: Set<string>): void {
  if (!isPlainRecord(raw)) {
    return;
  }
  if ('piece_categories' in raw) {
    warnLegacyConfigKey(seen, 'piece_categories', 'workflow_categories');
  }
  const pc = raw.piece_categories;
  if (isPlainRecord(pc)) {
    walkCategoryRoot(pc, seen);
  }
  const wc = raw.workflow_categories;
  if (isPlainRecord(wc)) {
    walkCategoryRoot(wc, seen);
  }
}

export function warnLegacyCategoryYamlKeysOncePerProcess(raw: unknown): void {
  warnLegacyCategoryYamlKeys(raw, legacyConfigKeyDeprecationSeen);
}
