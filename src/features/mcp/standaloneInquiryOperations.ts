import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { StandaloneInquiryStore, type InquiryOwner } from '../../infra/goals/standalone-inquiries.js';
import { jsonResult, pagedResult } from './response.js';
import type { AskStandaloneQuestionInput, ListStandaloneInquiriesInput, WithdrawStandaloneInquiryInput } from './schemas.js';
import { sendSavedStandaloneQuestionNotification } from '../manager/notifications.js';

export async function askTaktStandaloneQuestion(
  input: AskStandaloneQuestionInput, configDirectory: string, owner: InquiryOwner, signal: AbortSignal,
): Promise<CallToolResult> {
  signal.throwIfAborted();
  const { cwd, ...questionInput } = input;
  const question = await new StandaloneInquiryStore(configDirectory, owner).create({ ...questionInput,
    operation: { toolName: 'takt_ask_standalone_question', args: JSON.stringify(input), cwd },
  });
  await sendSavedStandaloneQuestionNotification(cwd, question);
  return jsonResult({ questionId: question.id });
}

export async function listTaktStandaloneInquiries(
  input: ListStandaloneInquiriesInput, configDirectory: string, owner: InquiryOwner,
): Promise<CallToolResult> {
  const offset = input.offset ?? 0;
  const store = new StandaloneInquiryStore(configDirectory, owner);
  const page = await store.listPendingPage(offset, input.limit ?? 50);
  return pagedResult('inquiries', page.inquiries.map((inquiry) => ({
    ...inquiry, kind: inquiry.kind ?? 'question', createdAt: inquiry.createdAt ?? null,
  })), page.totalCount, offset);
}

export async function withdrawTaktStandaloneInquiry(
  input: WithdrawStandaloneInquiryInput, configDirectory: string, owner: InquiryOwner,
): Promise<CallToolResult> {
  const store = new StandaloneInquiryStore(configDirectory, owner);
  return jsonResult({ inquiry: await store.withdraw(input.id, input.reason) });
}
