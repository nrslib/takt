import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function getLineCount(path: string): number {
  const content = readFileSync(new URL(path, import.meta.url), 'utf-8');
  return content.trimEnd().split(/\r?\n/).length;
}

describe('config module file-size boundary', () => {
  it('keeps globalConfigCore.ts under 300 lines', () => {
    const lineCount = getLineCount('../infra/config/global/globalConfigCore.ts');
    expect(lineCount).toBeLessThanOrEqual(300);
  });

  it('keeps globalConfig.ts as thin facade under 120 lines', () => {
    const lineCount = getLineCount('../infra/config/global/globalConfig.ts');
    expect(lineCount).toBeLessThanOrEqual(120);
  });

  it('keeps projectConfig.ts under 300 lines', () => {
    const lineCount = getLineCount('../infra/config/project/projectConfig.ts');
    expect(lineCount).toBeLessThanOrEqual(300);
  });

  it('keeps workflowExecution.ts under 300 lines', () => {
    const lineCount = getLineCount('../features/tasks/execute/workflowExecution.ts');
    expect(lineCount).toBeLessThanOrEqual(300);
  });

  it('keeps taskExecution.ts under 300 lines', () => {
    const lineCount = getLineCount('../features/tasks/execute/taskExecution.ts');
    expect(lineCount).toBeLessThanOrEqual(300);
  });

  it('keeps sessionLogger.ts under 300 lines', () => {
    const lineCount = getLineCount('../features/tasks/execute/sessionLogger.ts');
    expect(lineCount).toBeLessThanOrEqual(300);
  });

  it('keeps traceReport renderer/parser split modules under 300 lines', () => {
    const rendererLineCount = getLineCount('../features/tasks/execute/traceReportRenderer.ts');
    const parserLineCount = getLineCount('../features/tasks/execute/traceReportParser.ts');
    expect(rendererLineCount).toBeLessThanOrEqual(300);
    expect(parserLineCount).toBeLessThanOrEqual(300);
  });

  it('keeps traceReport.ts as thin facade under 120 lines', () => {
    const lineCount = getLineCount('../features/tasks/execute/traceReport.ts');
    expect(lineCount).toBeLessThanOrEqual(120);
  });

  it('keeps agent-usecases.ts as thin facade under 120 lines', () => {
    const lineCount = getLineCount('../agents/agent-usecases.ts');
    expect(lineCount).toBeLessThanOrEqual(120);
  });

  it('keeps split agent usecases under 300 lines each', () => {
    const judgeLineCount = getLineCount('../agents/judge-status-usecase.ts');
    const decomposeLineCount = getLineCount('../agents/decompose-task-usecase.ts');
    expect(judgeLineCount).toBeLessThanOrEqual(300);
    expect(decomposeLineCount).toBeLessThanOrEqual(300);
  });

  it('keeps task schema facade thin and split modules under 300 lines', () => {
    const facadeLineCount = getLineCount('../infra/task/schema.ts');
    const executionLineCount = getLineCount('../infra/task/taskExecutionSchemas.ts');
    const recordLineCount = getLineCount('../infra/task/taskRecordSchemas.ts');
    expect(facadeLineCount).toBeLessThanOrEqual(120);
    expect(executionLineCount).toBeLessThanOrEqual(300);
    expect(recordLineCount).toBeLessThanOrEqual(300);
  });

  it('keeps resource resolver facade thin and split helpers under 300 lines', () => {
    const facadeLineCount = getLineCount('../infra/config/loaders/resource-resolver.ts');
    const scopeLineCount = getLineCount('../infra/config/loaders/workflowPackageScope.ts');
    const personaPolicyLineCount = getLineCount('../infra/config/loaders/workflowPersonaPathPolicy.ts');
    expect(facadeLineCount).toBeLessThanOrEqual(300);
    expect(scopeLineCount).toBeLessThanOrEqual(300);
    expect(personaPolicyLineCount).toBeLessThanOrEqual(300);
  });
});
