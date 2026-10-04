#!/usr/bin/env node
// Capture production engine payloads while replacing only the provider boundary.
import { mock } from 'node:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { revisionRoot, workspace, configDirectory, sample, language, resultPath } = request;
const fixturePackage = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8'));
if (fixturePackage.scripts?.test !== 'node --test tests/session-label.test.js') throw new Error('Expected an isolated handoff fixture');
// Rebuild only this disposable fixture's engine-owned artifacts on each capture.
rmSync(join(workspace, '.takt'), { recursive: true, force: true });
mkdirSync(configDirectory, { recursive: true });
writeFileSync(join(configDirectory, 'config.yaml'), `language: ${language}\n`);
process.env.TAKT_CONFIG_DIR = configDirectory;

const calls = [];
const response = content => ({ persona: 'fixture', status: 'done', content, timestamp: new Date() });
mock.module(pathToFileURL(join(revisionRoot, 'dist/agents/runner.js')).href, {
  namedExports: {
    runAgent: async (persona, instruction, options) => {
      options.onPromptResolved?.({ systemPrompt: persona ?? '', userInstruction: instruction });
      options.onDispatch?.(options.permissionMode);
      const isReport = options.allowedTools?.length === 0;
      calls.push({ persona, instruction, phase: isReport ? 2 : 1, allowedTools: options.allowedTools, sessionIdPresent: options.sessionId !== undefined });
      if (isReport) return response('# Captured report payload');
      if (persona === 'fixture-upstream') return response(sample.upstream);
      return response(request.workResult ?? sample.workResult ?? '@@ACTUAL_PHASE1_RESPONSE@@');
    },
  },
});

const load = path => import(pathToFileURL(join(revisionRoot, 'dist', path)).href);
const { loadWorkflowByIdentifier, loadPersonaPromptFromPath } = await load('infra/config/index.js');
const { normalizeRule } = await load('infra/config/loaders/workflowRuleNormalizer.js');
const { WorkflowEngine } = await load('core/workflow/index.js');
const { LiveInterventionFileStore } = await load('infra/workflow/live-intervention-store.js');
const workflow = loadWorkflowByIdentifier('development-implement', workspace);
if (!workflow) throw new Error('Resolved builtin development-implement is missing');
const originalStep = workflow.steps.find(step => step.name === 'implement');
if (!originalStep || originalStep.kind === 'workflow_call') throw new Error('Builtin implement agent step is missing');
const step = {
  ...originalStep,
  // Select the real implementation contract; scope reporting is outside this experiment.
  outputContracts: originalStep.outputContracts.filter(contract => contract.name === 'implementation-report.md'),
  rules: [normalizeRule({ condition: 'done', next: 'COMPLETE' })],
};
if (step.outputContracts.length !== 1) throw new Error('Expected exactly one implementation report');
const steps = sample.upstream === undefined ? [step] : [{
  name: 'fixture-upstream', persona: 'fixture-upstream', personaDisplayName: 'Supplied planning conversation',
  instruction: 'Supply the recorded upstream conversation.', passPreviousResponse: false,
  rules: [
    normalizeRule({ condition: 'supplied', next: 'implement' }),
    normalizeRule({ condition: 'not_supplied', next: 'ABORT' }),
  ],
}, step];
const config = {
  name: 'report-phase-handoff', maxSteps: 2, initialStep: steps[0].name, steps,
  ...(sample.reportName === undefined ? {} : { allStepsRules: [{
    ref: 'accepted-delivery-obligations', position: 'before_instruction',
    content: `Use the supplied accepted planning obligations as the source of completion rows:\n{report:${sample.reportName}}`,
  }] }),
};
const reportDirectory = join(workspace, '.takt/runs/eval/reports');
mkdirSync(reportDirectory, { recursive: true });
const emptyArtifact = 'No completion-contract rows are defined in this artifact. Use the supplied planning handoff or selected planning source.\n';
writeFileSync(join(reportDirectory, 'plan.md'), emptyArtifact);
writeFileSync(join(reportDirectory, 'test-report.md'), emptyArtifact);
if (sample.reportName !== undefined) writeFileSync(join(reportDirectory, sample.reportName), sample.reportContent);
const liveIntervention = new LiveInterventionFileStore(workspace, 'eval');
if (sample.liveInput !== undefined && sample.upstream === undefined) {
  await liveIntervention.issue(sample.liveInput, '2026-10-03T00:00:00.000Z');
}
const structuredCaller = {
  judgeStatus: async (_instruction, _tag, _candidates, options) => {
    options.onStructuredPromptResolved?.({ systemPrompt: 'fixture conductor', userInstruction: 'Select the only completion transition.' });
    if (options.stepName === 'fixture-upstream' && sample.liveInput !== undefined) {
      await liveIntervention.issue(sample.liveInput, '2026-10-03T00:00:00.000Z');
    }
    return { candidateIndex: 0, method: 'structured_output' };
  },
  evaluateCondition: async () => 0,
  decomposeTask: async () => { throw new Error('Decomposition is outside this evaluation'); },
  requestMoreParts: async () => { throw new Error('Team feedback is outside this evaluation'); },
};
const engine = new WorkflowEngine(config, workspace, sample.task, {
  projectCwd: workspace, provider: 'codex', model: 'gpt-6-sol', language,
  reportDirName: 'eval', liveIntervention, structuredCaller,
  companionEnabled: false,
});
const aborts = [];
engine.on('workflow:abort', (_state, ...details) => aborts.push(details));
for (const input of sample.userInputs ?? []) engine.addUserInput(input);
const result = await engine.run();
if (result.status !== 'completed') throw new Error('Payload capture engine did not complete: ' + JSON.stringify({ status: result.status, aborts, calls }));
const phase1 = calls.find(call => call.phase === 1 && call.persona !== 'fixture-upstream');
const phase2 = calls.find(call => call.phase === 2);
if (!phase1 || !phase2) throw new Error('Missing production Phase 1/2 payload');
if (phase2.sessionIdPresent || phase2.allowedTools.length !== 0) throw new Error('Phase 2 must be fresh and tool-free');
const persona = step.personaPath ? loadPersonaPromptFromPath(step.personaPath, workspace).trim() : '';
writeFileSync(resolve(resultPath), JSON.stringify({
  phase1Prompt: persona ? `${persona}\n\n${phase1.instruction}` : phase1.instruction,
  phase2Prompt: persona ? `${persona}\n\n${phase2.instruction}` : phase2.instruction,
  phase2Options: { allowedTools: phase2.allowedTools, sessionIdPresent: phase2.sessionIdPresent },
  liveInstructions: liveIntervention.read().instructions.map(({ content, state, deliveryMode }) => ({ content, state, deliveryMode })),
}, null, 2) + '\n');
