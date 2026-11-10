// Main comparisons delegate assembly to that worktree's production plan and event builder.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { createManagerConversationPlan } from '../dist/features/manager/conversationPlan.js';
import { buildManagerEventPrompt } from '../dist/features/daemon/inboxEvent.js';
import { invalidateGlobalConfigCache } from '../dist/infra/config/global/globalConfig.js';
import { getLabel } from '../dist/shared/i18n/index.js';

export function buildManagerSystemPrompt(input) {
  const directory = mkdtempSync(join(tmpdir(), 'takt-manager-main-'));
  const prior = process.env.TAKT_CONFIG_DIR;
  try {
    process.env.TAKT_CONFIG_DIR = directory;
    invalidateGlobalConfigCache();
    mkdirSync(join(directory, '.takt'));
    writeFileSync(join(directory, '.takt/config.yaml'), stringify({
      provider: 'mock', language: input.lang, concurrency: input.concurrency,
      manager: { default_workflow: input.defaultWorkflow ?? undefined, main_merge: input.mainMerge },
      assistant: { formal_spec: { mode: input.specificationConfiguration.mode, comments: input.specificationConfiguration.comments,
        model_check_timeout_seconds: input.specificationConfiguration.modelCheckTimeoutSeconds } },
    }));
    for (const [kind, body] of Object.entries({ personas: input.facets.persona, policies: input.facets.policy,
      knowledge: input.facets.knowledge, instructions: input.facets.instruction })) {
      const path = join(directory, '.takt/facets', kind);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'manager.md'), body);
    }
    const { strategy } = createManagerConversationPlan(directory, { language: input.lang });
    return strategy.systemPrompt.replace(`Repository: ${JSON.stringify(directory)}`, `Repository: ${JSON.stringify(input.repository)}`);
  } finally {
    if (prior === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = prior;
    invalidateGlobalConfigCache();
    rmSync(directory, { recursive: true, force: true });
  }
}

export function buildManagerTurnPrompt({ lang, event, interruptedMessage }) {
  const body = event.kind === 'human_command' ? event.command.text
    : event.kind === 'director_message' ? `${event.text}\n\nSpeaker: ${JSON.stringify({ namespace: 'agent', id: 'director' })}`
      : buildManagerEventPrompt(event);
  return [
    ...(interruptedMessage == null ? [] : [getLabel('manager.conversation.interrupted_message', lang), interruptedMessage]), body,
  ].join('\n\n');
}
