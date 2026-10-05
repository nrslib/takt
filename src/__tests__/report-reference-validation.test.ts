import { describe, expect, it } from 'vitest';
import type { DynamicParallelSelectionMode, NormalAgentWorkflowStep, WorkflowConfig } from '../core/models/types.js';
import { validateWorkflowReportReferences, type ReportReferenceDiagnostic } from '../core/workflow/instruction/report-reference-validation.js';
import { makeRule, makeStep } from './test-helpers.js';

function validate(steps: WorkflowConfig['steps']): ReportReferenceDiagnostic[] {
  const workflow: WorkflowConfig = {
    name: 'reports', description: 'report validation', maxSteps: 10,
    initialStep: 'start', steps,
  };
  return validateWorkflowReportReferences(workflow, () => null, { projectCwd: '/project', lookupCwd: '/project' });
}

describe('report reference validation', () => {
  const participant = (name: string, reportName: string): NormalAgentWorkflowStep => ({
    name, personaDisplayName: name, instruction: `Run ${name}`, passPreviousResponse: false,
    ...(name === 'produce' ? { outputContracts: [{ name: reportName, format: 'report' }] } : {}),
  });

  function dynamicStep(fixed: string[], pool: string[], mode: DynamicParallelSelectionMode, reportName: string) {
    return makeStep({
      name: 'start',
      parallel: {
        kind: 'dynamic',
        fixed: fixed.map((name) => participant(name, reportName)),
        pool: pool.map((name) => ({ ...participant(name, reportName), description: `Run ${name}` })),
        selection: { mode },
      },
      rules: [makeRule('all("done")', 'consume')],
    });
  }

  describe.each(['replace', 'cumulative'] as const)('dynamic report guarantees (%s)', (mode) => {
    it.each([
      { fixed: [], pool: ['produce'], reportName: 'plan.md', warning: false },
      { fixed: ['idle'], pool: ['produce'], reportName: 'plan.md', warning: true },
      { fixed: ['produce'], pool: ['idle'], reportName: 'plan.md', warning: false },
      { fixed: [], pool: ['produce', 'other'], reportName: 'plan.md', warning: true },
      { fixed: ['produce'], pool: ['idle'], reportName: 'other.md', warning: true },
    ])('checks fixed=$fixed pool=$pool report=$reportName', ({ fixed, pool, reportName, warning }) => {
      const diagnostics = validate([
        dynamicStep(fixed, pool, mode, reportName),
        makeStep({ name: 'consume', instruction: '{report:plan.md}' }),
      ]);
      expect(diagnostics).toMatchObject(warning ? [{
        level: 'warning', message: expect.stringContaining('step "consume" references {report:plan.md}'),
      }] : []);
      if (warning && reportName === 'plan.md') {
        expect(diagnostics[0]?.message).not.toContain("no step's output_contracts produce that report");
        expect(diagnostics[0]?.runtimeCheck).toMatchObject({
          reference: 'plan.md',
          consumer: { workflowRef: 'reports', callPath: [], stepPath: ['consume'] },
        });
      } else if (warning) {
        expect(diagnostics[0]?.runtimeCheck).toBeUndefined();
      }
    });
  });

  it.each(['call', 'parallel call', 'grandchild', 'judge'] as const)('passes dynamic guarantees to %s', (consumer) => {
    const callStep = (name: string, target: string) => makeStep({
      name, kind: 'workflow_call', call: target, rules: [makeRule('COMPLETE', 'COMPLETE')],
    });
    const leaf: WorkflowConfig = {
      name: 'leaf', maxSteps: 10, initialStep: 'work', subworkflow: { callable: true },
      steps: [makeStep({ name: 'work', instruction: '{report:plan.md}' })],
    };
    const child: WorkflowConfig = consumer === 'grandchild'
      ? { ...leaf, name: 'child', initialStep: 'delegate', steps: [callStep('delegate', 'leaf')] }
      : { ...leaf, name: 'child' };
    for (const fixed of [[], ['idle']]) {
      const producer = dynamicStep(fixed, ['produce'], 'replace', 'plan.md');
      const workflow: WorkflowConfig = {
        name: 'parent', maxSteps: 10, initialStep: 'start',
        steps: [producer, consumer === 'judge'
          ? makeStep({ name: 'consume', rules: [makeRule('done', 'start')] })
          : consumer === 'parallel call'
            ? makeStep({ name: 'consume', parallel: [callStep('delegate', 'child')], rules: [makeRule('all("COMPLETE")', 'COMPLETE')] })
            : callStep('consume', 'child')],
        ...(consumer === 'judge' ? { loopMonitors: [{
          cycle: ['start', 'consume'], threshold: 1,
          judge: { instruction: '{report:plan.md}', rules: [{ condition: makeRule('done', 'COMPLETE').condition, next: 'COMPLETE' }] },
        }] } : {}),
      };
      const diagnostics = validateWorkflowReportReferences(workflow, ({ step }) => step.call === 'leaf' ? leaf : child, {
        projectCwd: '/project', lookupCwd: '/project',
      });
      expect(diagnostics).toMatchObject(fixed.length === 0 ? [] : [{
        level: 'warning', message: expect.stringContaining('{report:plan.md}'),
      }]);
      if (fixed.length > 0) {
        expect(diagnostics[0]?.message).toContain('before any step producing the report has run');
        expect(diagnostics[0]?.runtimeCheck?.consumer).toEqual(consumer === 'judge'
          ? { workflowRef: 'parent', callPath: [], stepPath: ['_loop_judge_start_consume'] }
          : {
              workflowRef: consumer === 'grandchild' ? 'leaf' : 'child',
              callPath: [
                { workflowRef: 'parent', step: 'consume' },
                ...(consumer === 'parallel call' ? [{ workflowRef: 'parent', step: 'delegate' }] : []),
                ...(consumer === 'grandchild' ? [{ workflowRef: 'child', step: 'delegate' }] : []),
              ],
              stepPath: ['work'],
            });
      }
    }
  });

  it.each(['plan.md', 'other.md'])('preserves all participants of an array parallel producing %s', (reportName) => {
    const diagnostics = validate([
      makeStep({ name: 'start', parallel: [participant('produce', reportName), participant('idle', reportName)], rules: [makeRule('done', 'consume')] }),
      makeStep({ name: 'consume', instruction: '{report:plan.md}' }),
    ]);
    expect(diagnostics).toEqual(reportName === 'plan.md' ? [] : [{
      level: 'warning', message: expect.stringContaining('{report:plan.md}'),
    }]);
  });

  it('validates references in every optional pool candidate', () => {
    const start = dynamicStep(['idle'], ['produce', 'other'], 'replace', 'plan.md');
    if (start.parallel === undefined || Array.isArray(start.parallel)) throw new Error('Expected dynamic parallel fixture');
    const diagnostics = validate([
      { ...start, parallel: { ...start.parallel, pool: start.parallel.pool.map((step) => ({ ...step, instruction: '{report:ghost.md}' })) } },
      makeStep({ name: 'consume' }),
    ]);
    expect(diagnostics).toEqual(['produce', 'other'].map((name) => ({
      level: 'warning', message: expect.stringContaining(`step "${name}" references {report:ghost.md}`),
    })));
  });

  it('accepts an earlier report after trimming the instruction reference', () => {
    expect(validate([
      makeStep({ name: 'start', outputContracts: [{ name: 'plan.md', format: '{report:future.md}' }], rules: [makeRule('done', 'consume')] }),
      makeStep({ name: 'consume', instruction: '{report: plan.md }' }),
    ])).toEqual([]);
  });

  it('warns when one incoming route bypasses the producer', () => {
    const diagnostics = validate([
      makeStep({ name: 'start', rules: [makeRule('produce', 'produce'), makeRule('skip', 'consume')] }),
      makeStep({ name: 'produce', outputContracts: [{ name: 'plan.md', format: 'report' }], rules: [makeRule('done', 'consume')] }),
      makeStep({ name: 'consume', instruction: '{report:plan.md}' }),
    ]);
    expect(diagnostics).toEqual([{
      level: 'warning',
      message: expect.stringContaining('step "consume" references {report:plan.md}'),
    }]);
    expect(diagnostics[0]?.runtimeCheck).toBeUndefined();
  });

  it('does not defer a reference to a future optional producer', () => {
    const start = makeStep({ name: 'start', instruction: '{report:plan.md}', rules: [makeRule('done', 'select')] });
    const select = { ...dynamicStep([], ['produce', 'other'], 'replace', 'plan.md'), name: 'select',
      rules: [makeRule('done', 'COMPLETE')] };
    const diagnostics = validate([start, select]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.runtimeCheck).toBeUndefined();
    expect(diagnostics[0]?.message).toContain('before any step producing the report has run');
  });

  it('retains the parallel position and normalized name of a deferred consumer', () => {
    const diagnostics = validate([
      dynamicStep([], ['produce', 'other'], 'replace', 'plan.md'),
      makeStep({ name: 'consume', parallel: [
        makeStep({ name: 'work', instruction: '{report: plan.md }' }),
      ] }),
    ]);
    expect(diagnostics[0]?.runtimeCheck).toMatchObject({
      reference: 'plan.md',
      consumer: { workflowRef: 'reports', callPath: [], stepPath: ['consume', 'work'] },
    });
  });

  it.each(['parallel', 'arpeggio'] as const)('preserves preflight diagnostics outside the shared instruction preparation for %s', (runner) => {
    const consume = makeStep({ name: 'consume', instruction: '{report:plan.md}',
      ...(runner === 'parallel'
        ? { parallel: [makeStep({ name: 'work', instruction: 'Work' })] }
        : { arpeggio: {
            source: 'csv', sourcePath: 'input.csv', batchSize: 1, concurrency: 1,
            templatePath: 'batch.md', merge: { strategy: 'concat' }, maxRetries: 0, retryDelayMs: 0,
          } }),
    });
    const diagnostics = validate([dynamicStep([], ['produce', 'other'], 'replace', 'plan.md'), consume]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.runtimeCheck).toBeUndefined();
    expect(diagnostics[0]?.message).toContain('step "consume" references {report:plan.md}');
  });

  it('reports invalid paths instead of accepting them as producers', () => {
    const diagnostics = validate([makeStep({ name: 'start', instruction: '{report:../plan.md}' })]);
    expect(diagnostics).toEqual([{ level: 'error', message: expect.stringContaining('step "start"') }]);
  });
});
