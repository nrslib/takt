export function getSession(): Promise<unknown>;
export function getTasks(): Promise<unknown>;
export function getProjects(): Promise<unknown>;
export function getWorkflows(projectId: string): Promise<unknown>;
export function getRun(projectId: string, slug: string): Promise<unknown>;
export interface RunOccurrencePrompt {
  readonly timestamp?: string;
  readonly step?: string;
  readonly phase?: number;
  readonly phaseName?: string;
  readonly phaseExecutionId?: string;
  readonly iteration?: number;
  readonly workflow?: string;
  readonly systemPrompt?: string;
  readonly userInstruction?: string;
  readonly instruction?: string;
}

export interface RunOccurrenceArtifactReport {
  readonly filename: string;
  readonly content: string;
  readonly omitted: boolean;
}

export interface RunOccurrenceArtifactsResponse {
  readonly reports: readonly RunOccurrenceArtifactReport[];
  readonly prompts: readonly RunOccurrencePrompt[];
  readonly promptsTruncated: boolean;
  readonly omittedPromptCount: number;
  readonly outcome?: Readonly<Record<string, unknown>>;
}

export function getRunOccurrenceArtifacts(
  projectId: string,
  slug: string,
  occurrenceId: string,
  signal?: AbortSignal,
): Promise<RunOccurrenceArtifactsResponse>;
export function browseDirectories(path: string | null): Promise<unknown>;
export function pickNativeDirectory(): Promise<unknown>;
export function registerProject(projectDirectory: string): Promise<unknown>;
export function startTask(request: unknown): Promise<unknown>;
export function requeueTask(projectId: string, taskId: string): Promise<unknown>;
export function runTaskAction(
  projectId: string,
  taskId: string,
  action: string,
  input?: string,
  conversationId?: string,
  taskActionOptionId?: string,
): Promise<unknown>;
export function createChatSession(request: unknown): Promise<unknown>;
export function reconfigureChatSession(
  sessionId: string,
  request: unknown,
): Promise<unknown>;
export function restartChatSession(sessionId: string): Promise<unknown>;
export function sendChatMessage(
  sessionId: string,
  text: string,
  onThinking: (content: string) => void,
  taskActionOptionId?: string,
): Promise<unknown>;
