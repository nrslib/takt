import { access, mkdir, opendir, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod/v4';
import { readFileSync } from 'node:fs';
import { projectIdForCanonicalDirectory } from '../config/global/projectRegistry.js';
import { writeFileAtomic } from '../config/project/sessionStore.js';
import { withFileLock } from '../fs/file-lock.js';
import { createInquiry, answerInquiry, withdrawInquiry, consumeInquiryApproval } from './inquiry.js';
import { isSameGoalOperation } from './questions.js';
import { GoalQuestionSchema, type GoalAnswerInput, type GoalQuestion, type GoalQuestionInput } from './schema.js';

export type InquiryOwner =
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'repository'; readonly repositoryDirectory: string };

const INQUIRIES_DIRECTORY = 'inquiries';
const IdSchema = z.uuid();

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export class StandaloneInquiryStore {
  constructor(private readonly configDirectory: string, private readonly owner: InquiryOwner) {}

  async create(input: GoalQuestionInput): Promise<GoalQuestion> {
    const question = createInquiry(input);
    const directory = await this.directory();
    const path = join(directory, `${question.id}.json`);
    await this.assertUnusedId(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    this.write(path, question);
    return question;
  }

  async getOrCreateApproval(input: GoalQuestionInput & { kind: 'approval' }): Promise<GoalQuestion> {
    const candidate = createInquiry(input);
    const directory = await this.directory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let existing: { name: string; question: GoalQuestion } | undefined;
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = IdSchema.parse(entry.name.slice(0, -'.json'.length));
      const question = await this.read(join(directory, entry.name), id);
      if (question.kind === 'approval' && question.status === 'pending' && isSameGoalOperation(question, candidate)
        && (existing === undefined || entry.name.localeCompare(existing.name) < 0)) {
        existing = { name: entry.name, question };
      }
    }
    if (existing !== undefined) return existing.question;
    const path = join(directory, `${candidate.id}.json`);
    await this.assertUnusedId(path);
    this.write(path, candidate);
    return candidate;
  }

  async list(): Promise<GoalQuestion[]> {
    const directory = await this.directory();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const questions: GoalQuestion[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = IdSchema.parse(entry.name.slice(0, -'.json'.length));
      questions.push(await this.read(join(directory, entry.name), id));
    }
    return questions;
  }

  async listPending(): Promise<GoalQuestion[]> {
    const directory = await this.directory();
    let entries;
    try { entries = await opendir(directory); }
    catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const questions: GoalQuestion[] = [];
    for await (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = IdSchema.parse(entry.name.slice(0, -'.json'.length));
      const question = await this.read(join(directory, entry.name), id);
      if (question.status === 'pending') questions.push(question);
    }
    return questions;
  }

  async answer(id: string, answer: string | GoalAnswerInput): Promise<GoalQuestion> {
    const path = join(await this.directory(), `${IdSchema.parse(id)}.json`);
    const answered = answerInquiry(await this.read(path, id), answer);
    this.write(path, answered);
    return answered;
  }

  async withdraw(id: string, reason?: string): Promise<GoalQuestion> {
    const path = join(await this.directory(), `${IdSchema.parse(id)}.json`);
    const question = await this.read(path, id);
    const withdrawn = withdrawInquiry(question, reason);
    if (withdrawn !== question) this.write(path, withdrawn);
    return withdrawn;
  }

  async consumeApproval(expected: GoalQuestion, consumedAt: string): Promise<GoalQuestion> {
    const path = join(await this.directory(), `${IdSchema.parse(expected.id)}.json`);
    return withFileLock(`${path}.lock`, () => {
      const current = GoalQuestionSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      if (current.id !== expected.id || !isSameGoalOperation(current, expected)) {
        throw new Error('Saved approval differs from the requested operation');
      }
      const consumed = consumeInquiryApproval(current, consumedAt);
      this.write(path, consumed);
      return consumed;
    });
  }

  private async directory(): Promise<string> {
    const directory = this.owner.kind === 'workspace'
      ? join(this.configDirectory, 'workspaces', IdSchema.parse(this.owner.workspaceId))
      : join(this.configDirectory, 'projects', projectIdForCanonicalDirectory(await realpath(this.owner.repositoryDirectory)));
    return join(directory, INQUIRIES_DIRECTORY);
  }

  private async read(path: string, id: string): Promise<GoalQuestion> {
    const question = GoalQuestionSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    if (question.id !== id) throw new Error('Saved question ID differs from its filename');
    return question;
  }

  private async assertUnusedId(path: string): Promise<void> {
    try { await access(path); }
    catch (error) {
      if (!isMissing(error)) throw error;
      return;
    }
    throw new Error('Question ID already exists');
  }

  private write(path: string, question: GoalQuestion): void {
    const parsed = GoalQuestionSchema.parse(question);
    writeFileAtomic(path, `${JSON.stringify(parsed, null, 2)}\n`, 0o600);
  }
}
