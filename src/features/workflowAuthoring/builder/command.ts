import { inspectWorkflowFile } from '../../../infra/config/loaders/workflowDoctor.js';
import { callAIWithRetry, displayAndClearSessionState, runConversationLoop, type ConversationGoContext } from '../../interactive/conversationLoop.js';
import { initializeSession } from '../../interactive/sessionInitialization.js';
import { selectOption, type SelectOptionItem } from '../../../shared/prompt/index.js';
import { error, info, success } from '../../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import { BUILDER_GO_TOOLS, BUILDER_READ_TOOLS } from './constants.js';
import { buildBuilderChangeApproval } from './approval.js';
import {
  applyBuilderChangeManifest,
  parseBuilderChangeManifest,
  resolveBuilderManifestChanges,
} from './manifest.js';
import {
  buildBuilderPromptContext,
  buildBuilderSystemPrompt,
} from './promptContext.js';
import {
  buildBuilderScopeChoices,
  listBuilderTargetWorkflows,
  resolveBuilderScope,
} from './scope.js';
import {
  categorizeBuilderChanges,
  diffSnapshots,
  rollbackBuilderFileChanges,
  snapshotBuilderChangeFiles,
  summarizeFileChanges,
  toRollbackChanges,
} from './snapshot.js';
import type {
  BuilderChangeManifest,
  BuilderTarget,
  BuilderTargetMode,
  ResolvedBuilderScope,
} from './types.js';
import {
  buildBuilderValidationFeedback,
  findBuilderChangeViolation,
  resolveBuilderValidationTargets,
} from './validation.js';

export async function builderWorkflowCommand(options: { projectDir: string }): Promise<void> {
  const ctx = initializeSession(options.projectDir, 'workflow-builder');
  displayAndClearSessionState(options.projectDir, ctx.lang);

  const scopeKind = await selectRequiredOption('Select output scope:', buildBuilderScopeChoices(options.projectDir));
  const scope = resolveBuilderScope({ projectDir: options.projectDir, scope: scopeKind });
  const target = await selectBuilderTarget(scope);
  const promptContext = buildBuilderPromptContext({ scope, target });
  const systemPrompt = buildBuilderSystemPrompt(ctx.lang, promptContext);

  await runConversationLoop(options.projectDir, ctx, {
    systemPrompt,
    allowedTools: BUILDER_READ_TOOLS,
    transformPrompt: (message) => message,
    introMessage: 'Workflow Builder is ready. Describe the workflow you want to create or change. Use /go to apply changes, or /cancel to discard.',
    disableDirectExecuteCommands: true,
    enableResumeCommand: false,
    handleGo: (goContext) => handleBuilderGo({
      projectDir: options.projectDir,
      scope,
      target,
      systemPrompt,
      goContext,
    }),
  }, undefined, undefined);
}

async function selectBuilderTarget(scope: ResolvedBuilderScope): Promise<BuilderTarget> {
  const mode = await selectRequiredOption<BuilderTargetMode>('Select target:', [
    { label: 'Create a new workflow', value: 'create' },
    { label: 'Modify an existing workflow', value: 'modify' },
    { label: 'Do not narrow yet', value: 'unspecified' },
  ]);
  if (mode !== 'modify') {
    return { mode };
  }

  const workflows = listBuilderTargetWorkflows(scope);
  if (workflows.length === 0) {
    throw new Error('No workflow files found in the selected scope.');
  }
  const selectedPath = await selectRequiredOption('Select workflow:', workflows.map((workflow) => ({
    label: workflow.lang ? `${workflow.lang}: ${workflow.name}` : workflow.name,
    value: workflow.path,
  })));
  return { mode: 'modify', workflowPath: selectedPath };
}

async function selectRequiredOption<T extends string>(
  message: string,
  choices: SelectOptionItem<T>[],
): Promise<T> {
  const selected = await selectOption<T>(message, choices);
  if (!selected) {
    throw new Error('Workflow builder cancelled before conversation started.');
  }
  return selected;
}

async function handleBuilderGo(options: {
  projectDir: string;
  scope: ResolvedBuilderScope;
  target: BuilderTarget;
  systemPrompt: string;
  goContext: ConversationGoContext;
}) {
  const prompt = buildBuilderGoPrompt(options.goContext);
  const approval = buildBuilderChangeApproval({
    scope: options.scope,
    target: options.target,
    goContext: options.goContext,
  });
  info('Applying workflow builder changes...');
  const { result } = await callAIWithRetry(
    prompt,
    options.systemPrompt,
    BUILDER_GO_TOOLS,
    options.projectDir,
    { ...options.goContext.ctx, sessionId: options.goContext.sessionId },
  );
  if (!result) {
    info('Workflow builder did not return a result.');
    return null;
  }
  if (!result.success) {
    error(result.content);
    return { action: 'cancel' as const, task: '' };
  }

  const parsed = parseBuilderManifestForGo(options.projectDir, options.scope, result.content);
  if (!parsed) {
    return null;
  }
  const { manifest, manifestChanges } = parsed;
  const plannedViolation = findBuilderChangeViolation(options.scope, manifestChanges, approval);
  if (plannedViolation) {
    error(plannedViolation);
    info('Workflow builder did not apply changes. Confirm the target scope and run /go again.');
    return null;
  }
  try {
    return applyAndValidateBuilderManifest({
      projectDir: options.projectDir,
      scope: options.scope,
      manifest,
      manifestChanges,
      approval,
      goContext: options.goContext,
    });
  } catch (applyError) {
    const message = sanitizeTerminalText(applyError instanceof Error ? applyError.message : String(applyError));
    error(message);
    options.goContext.history.push({
      role: 'assistant',
      content: buildBuilderValidationFeedback([message]),
    });
    info('Workflow builder changes were rolled back. Fix the reported issue, then run /go again.');
    return null;
  }
}

function applyAndValidateBuilderManifest(options: {
  projectDir: string;
  scope: ResolvedBuilderScope;
  manifest: BuilderChangeManifest;
  manifestChanges: ReturnType<typeof resolveBuilderManifestChanges>;
  approval: ReturnType<typeof buildBuilderChangeApproval>;
  goContext: ConversationGoContext;
}) {
  const before = snapshotBuilderChangeFiles(options.manifestChanges);
  try {
    applyBuilderChangeManifest(options.projectDir, options.scope, options.manifest);
    const after = snapshotBuilderChangeFiles(options.manifestChanges);
    const changes = diffSnapshots(before, after);
    const violation = findBuilderChangeViolation(options.scope, summarizeFileChanges(changes), options.approval);
    if (violation) {
      rollbackBuilderFileChanges(toRollbackChanges(changes));
      error(violation);
      info('Workflow builder changes were rolled back. Confirm the target scope and run /go again.');
      return null;
    }
    const changed = categorizeBuilderChanges(changes);
    const validationTargets = resolveBuilderValidationTargets({
      scope: options.scope,
      changedWorkflowPaths: changed.workflowPaths,
      changedFacetPaths: changed.facetPaths,
    });
    const diagnostics = collectBuilderValidationDiagnostics(validationTargets, options.projectDir);
    if (diagnostics.length > 0) {
      rollbackInvalidBuilderChanges(changes, diagnostics, options.goContext);
      return null;
    }

    success(`Workflow builder completed. Validated ${validationTargets.length} workflow file(s).`);
    return { action: 'execute' as const, task: options.manifest.summary };
  } catch (applyError) {
    const after = snapshotBuilderChangeFiles(options.manifestChanges);
    const changes = diffSnapshots(before, after);
    rollbackBuilderFileChanges(toRollbackChanges(changes));
    const message = sanitizeTerminalText(applyError instanceof Error ? applyError.message : String(applyError));
    error(message);
    options.goContext.history.push({
      role: 'assistant',
      content: buildBuilderValidationFeedback([message]),
    });
    info('Workflow builder changes were rolled back. Fix the reported issue, then run /go again.');
    return null;
  }
}

function parseBuilderManifestForGo(
  projectDir: string,
  scope: ResolvedBuilderScope,
  content: string,
): { manifest: BuilderChangeManifest; manifestChanges: ReturnType<typeof resolveBuilderManifestChanges> } | undefined {
  try {
    const manifest = parseBuilderChangeManifest(content);
    const manifestChanges = resolveBuilderManifestChanges(projectDir, scope, manifest);
    return { manifest, manifestChanges };
  } catch (parseError) {
    error(sanitizeTerminalText(parseError instanceof Error ? parseError.message : String(parseError)));
    info('Workflow builder did not apply changes. Return a valid change manifest and run /go again.');
    return undefined;
  }
}

function collectBuilderValidationDiagnostics(validationTargets: string[], projectDir: string): string[] {
  return validationTargets.flatMap((filePath) => {
    const report = inspectWorkflowFile(filePath, projectDir);
    return report.diagnostics
      .filter((diagnostic) => diagnostic.level === 'error')
      .map((diagnostic) => `${filePath}: ${diagnostic.message}`);
  });
}

function rollbackInvalidBuilderChanges(
  changes: Parameters<typeof toRollbackChanges>[0],
  diagnostics: string[],
  goContext: ConversationGoContext,
): void {
  error(`Workflow doctor found ${diagnostics.length} error(s):`);
  for (const diagnostic of diagnostics) {
    error(sanitizeTerminalText(diagnostic));
  }
  rollbackBuilderFileChanges(toRollbackChanges(changes));
  goContext.history.push({
    role: 'assistant',
    content: buildBuilderValidationFeedback(diagnostics),
  });
  info('Fix the reported workflow builder changes, then run /go again.');
}

function buildBuilderGoPrompt(context: ConversationGoContext): string {
  const transcript = context.history
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join('\n\n');
  return [
    'Apply the workflow builder plan now.',
    'Do not write files directly. Return a JSON change manifest only.',
    'The manifest must be valid JSON with this shape: {"summary":"...","changes":[{"path":"workflows/example.yaml","content":"..."}]}.',
    'Use paths relative to the selected scope root. For builtin scope, prefix paths with "en:" or "ja:".',
    'Include only workflow YAML and related facet files confirmed by the user.',
    context.inlineText ? `User /go note:\n${context.inlineText}` : '',
    transcript ? `Conversation transcript:\n${transcript}` : 'No conversation transcript is available.',
  ].filter((part) => part.length > 0).join('\n\n');
}
