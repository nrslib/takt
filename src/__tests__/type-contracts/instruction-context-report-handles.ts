import type { InstructionContext } from '../../core/workflow/instruction/instruction-context.js';

declare const context: InstructionContext;

// @ts-expect-error InstructionContext must not expose legacy report handles.
void context.currentReport;
// @ts-expect-error InstructionContext must not expose legacy report handles.
void context.previousReport;
// @ts-expect-error InstructionContext must not expose legacy report handles.
void context.peerReports;
// @ts-expect-error InstructionContext must not expose legacy report handles.
void context.reportHistory;
