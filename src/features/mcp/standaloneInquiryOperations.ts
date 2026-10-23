import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { StandaloneInquiryStore, type InquiryOwner } from '../../infra/goals/standalone-inquiries.js';
import { jsonResult, pagedResult } from './response.js';
import type { ListStandaloneInquiriesInput, WithdrawStandaloneInquiryInput } from './schemas.js';

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
