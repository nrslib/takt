import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const MERGE_CI_TARGETS = ['merge-ci-investigation', 'merge-ci-review'];
const investigationCases = [
  { id: 'clock', log: 'clock.txt' },
  { id: 'clock-main', log: 'clock.txt', baseAlsoFails: true },
  { id: 'runner', log: 'runner.txt' },
  { id: 'runner-403', log: 'runner.txt', denied: true },
  { id: 'secret', log: 'secret.txt' },
  { id: 'secret-empty', log: 'secret.txt', empty: true },
];
const reviewCases = ['product-fix', 'product-delete', 'clock-fix', 'clock-relax', 'gate-removal']
  .map((id) => ({ id, log: id.startsWith('clock') ? 'clock.txt' : 'product.txt' }));

export async function prepareMergeCiRecovery(targets) {
  const { loadWorkflowByIdentifier, loadPersonaPromptFromPath } = await import('../../dist/infra/config/index.js');
  const { InstructionBuilder } = await import('../../dist/core/workflow/instruction/InstructionBuilder.js');
  const { createInitialState } = await import('../../dist/core/workflow/engine/state-manager.js');
  const { invalidateGlobalConfigCache } = await import('../../dist/infra/config/global/globalConfigCore.js');
  for (const suite of targets) {
    const reviewing = suite === 'merge-ci-review';
    const stepName = reviewing ? 'review_ci_fix' : 'investigate_ci';
    for (const language of ['ja', 'en']) for (const spec of reviewing ? reviewCases : investigationCases) {
      const id = `${suite}-${language}-${spec.id}`;
      const project = join(repo, 'eval/.work/merge-ci-recovery', id);
      rmSync(project, { recursive: true, force: true });
      mkdirSync(project, { recursive: true });
      for (const name of ['product.mjs', 'product.test.mjs', 'clock.mjs', 'clock.test.mjs', 'ci.yaml', 'contract.md', 'cumulative.diff']) {
        cpSync(join(repo, 'eval/fixtures/merge-ci-recovery/common', name), join(project, name));
      }
      const configDir = join(project, '.takt');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.yaml'), `language: ${language}\n`);
      invalidateGlobalConfigCache();
      const workflowPath = join(repo, 'builtins', language, 'workflows/merge-review-fix.yaml');
      const workflow = loadWorkflowByIdentifier(workflowPath, project);
      const step = workflow?.steps.find((candidate) => candidate.name === stepName);
      if (!step || step.kind !== 'agent') throw new Error(`Missing recovery step: ${id}`);
      const state = createInitialState(workflow, { provider: 'codex', projectCwd: project });
      const headSha = 'a'.repeat(40);
      const log = spec.denied || spec.empty ? '' : readFileSync(join(repo, 'eval/fixtures/merge-ci-recovery/common', spec.log), 'utf8');
      // Only the scenario's evidence is exposed; paired cases must not see the other logs.
      const failure = { number: 123, headSha, complete: !spec.denied && !spec.empty,
        checks: [{ name: spec.log === 'secret.txt' ? 'deploy' : 'unit',
          run: { id: 10, attempt: 1, headSha, url: 'https://github.com/org/repo/actions/runs/10' },
          jobs: [{ id: 20, name: 'worker', url: 'https://github.com/org/repo/actions/runs/10/job/20', ...(log ? { log } : {}) }] }],
        unavailable: spec.denied ? [{ name: 'unit', reason: 'HTTP 403: permission denied when fetching job logs' }]
          : spec.empty ? [{ name: 'deploy', reason: 'Failed job returned an empty log' }] : [],
        fixRounds: reviewing ? 1 : 0, rerunCount: 0 };
      state.systemContexts.set('collect_ci_failure', { failure });
      state.effectResults.set('caccia', { caccia: { headSha } });
      const reportDir = join(project, '.takt/runs/eval/reports');
      mkdirSync(reportDir, { recursive: true });
      if (reviewing) {
        cpSync(join(repo, 'eval/fixtures/merge-ci-recovery', spec.id, 'repair.diff'), join(project, 'repair.diff'));
        const investigation = spec.log === 'clock.txt'
          ? 'clock.test.mjs:9 assumes setTimeout(5) resumes before the 20 ms TTL. The scheduler trace shows 31 ms; deterministic clock control must preserve both TTL assertions.'
          : 'product.mjs:2 dereferences null although the optional-tag contract accepts null. product.test.mjs requires an empty string; the TypeError demonstrates the missing guard.';
        state.structuredOutputs.set('investigate_ci', { verdict: 'defect', summary: investigation });
        writeFileSync(join(reportDir, 'ci-investigation.md'), investigation);
        cpSync(join(repo, 'eval/fixtures/merge-ci-recovery/common', spec.log.replace('.txt', '.verification.md')), join(project, 'verification.md'));
        writeFileSync(join(reportDir, 'ci-fix.md'), 'The proposed change is recorded in repair.diff. Read verification.md and compare the patch against the original source and contract.');
      }
      const policy = step.policyContents.map(({ content }) => content).join('\n\n');
      const policySourcePath = join(configDir, 'recovery-policy.md');
      writeFileSync(policySourcePath, policy);
      const persona = loadPersonaPromptFromPath(step.personaPath, project).trim();
      const schema = JSON.parse(readFileSync(join(repo, 'builtins/schemas', `${reviewing ? 'simple-review-result' : 'merge-ci-investigation'}.json`), 'utf8'));
      const task = [
        'Evaluate the supplied recorded CI scenario read-only. contract.md defines the contract; cumulative.diff is the cumulative PR diff against base. Source and tests are the original versions; repair.diff (when supplied) is the exact proposed repair. Review that patch against the originals.',
        spec.baseAlsoFails ? 'The latest main run fails with the identical clock test and scheduler trace.' : '',
        'Only failure-evidence.json contains the available CI evidence. Do not infer omitted logs from neighboring files. Do not access external services or the enclosing repository.',
      ].filter(Boolean).join('\n');
      writeFileSync(join(project, 'failure-evidence.json'), JSON.stringify(failure, null, 2));
      const instruction = new InstructionBuilder(step, {
        task, iteration: reviewing ? 12 : 8, maxSteps: workflow.maxSteps, stepIteration: 1,
        cwd: project, projectCwd: project, userInputs: [], reportDir, workflowState: state,
        policySourcePath, language, workflowName: workflow.name, workflowSteps: workflow.steps,
        currentStepIndex: workflow.steps.findIndex((candidate) => candidate.name === stepName),
      }).build();
      const prompt = `${persona}\n\n${instruction}\n\nEvaluation output transport: present the report and reasoning in your response (do not write files), then end with one JSON code block conforming to this production schema:\n${JSON.stringify(schema)}`;
      const outputDir = join(repo, 'eval/prompts');
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(join(outputDir, `${id}.phase1.md`), prompt);
      writeFileSync(join(configDir, 'facets.json'), JSON.stringify({ workflowPath, stepName, language, persona,
        instruction: step.instruction, policy, outputContracts: step.outputContracts, schema }, null, 2));
      console.log(`Prepared ${id}`);
    }
  }
}
