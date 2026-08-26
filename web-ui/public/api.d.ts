export function getSession(): Promise<unknown>;
export function getRuns(): Promise<unknown>;
export function getProjects(): Promise<unknown>;
export function getWorkflows(projectId: string): Promise<unknown>;
export function getRun(projectId: string, slug: string): Promise<unknown>;
export function browseDirectories(token: string, path: string | null): Promise<unknown>;
export function pickNativeDirectory(token: string): Promise<unknown>;
export function registerProject(token: string, projectDirectory: string): Promise<unknown>;
export function startRun(token: string, request: unknown): Promise<unknown>;
export function createChatSession(token: string, request: unknown): Promise<unknown>;
export function reconfigureChatSession(
  token: string,
  sessionId: string,
  request: unknown,
): Promise<unknown>;
export function restartChatSession(token: string, sessionId: string): Promise<unknown>;
export function sendChatMessage(
  token: string,
  sessionId: string,
  text: string,
  onThinking: (content: string) => void,
): Promise<unknown>;
