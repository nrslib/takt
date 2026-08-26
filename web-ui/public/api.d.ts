export function getSession(): Promise<unknown>;
export function getRuns(): Promise<unknown>;
export function getProjects(): Promise<unknown>;
export function getWorkflows(projectId: string): Promise<unknown>;
export function getRun(projectId: string, slug: string): Promise<unknown>;
export function browseDirectories(path: string | null): Promise<unknown>;
export function pickNativeDirectory(): Promise<unknown>;
export function registerProject(projectDirectory: string): Promise<unknown>;
export function startRun(request: unknown): Promise<unknown>;
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
): Promise<unknown>;
