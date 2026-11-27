import { z } from 'zod/v4';

const openCodeEnvironmentVariables = {
  path: 'TAKT_OPENCODE_PATH',
  version: 'TAKT_OPENCODE_VERSION',
  callTimeoutMs: 'TAKT_OPENCODE_CALL_TIMEOUT_MS',
  messageCycleBudget: 'TAKT_OPENCODE_MESSAGE_CYCLE_BUDGET',
  eventLimit: 'TAKT_OPENCODE_STREAM_EVENT_LIMIT',
  textByteLimit: 'TAKT_OPENCODE_STREAM_TEXT_BYTE_LIMIT',
  reasoningByteLimit: 'TAKT_OPENCODE_STREAM_REASONING_BYTE_LIMIT',
  idLimit: 'TAKT_OPENCODE_STREAM_ID_LIMIT',
  toolErrorWindow: 'TAKT_OPENCODE_TOOL_ERROR_WINDOW',
  toolErrorWindowRate: 'TAKT_OPENCODE_TOOL_ERROR_WINDOW_RATE',
  toolErrorConsecutive: 'TAKT_OPENCODE_TOOL_ERROR_CONSECUTIVE',
  editConflictRepeats: 'TAKT_OPENCODE_EDIT_CONFLICT_REPEATS',
  editCorrectionLimit: 'TAKT_OPENCODE_EDIT_CORRECTION_LIMIT',
} as const;

type OpenCodeEnvironmentField = keyof typeof openCodeEnvironmentVariables;
const openCodeEnvironmentShape = Object.fromEntries(
  Object.keys(openCodeEnvironmentVariables).map((field) => [field, z.string().optional()]),
) as Record<OpenCodeEnvironmentField, z.ZodOptional<z.ZodString>>;

export const RemoteOpenCodeEnvironmentSchema = z.object(openCodeEnvironmentShape).strict();
type RemoteOpenCodeEnvironment = z.infer<typeof RemoteOpenCodeEnvironmentSchema>;

export function captureRemoteOpenCodeEnvironment(environment: NodeJS.ProcessEnv): RemoteOpenCodeEnvironment {
  return RemoteOpenCodeEnvironmentSchema.parse(Object.fromEntries(
    Object.entries(openCodeEnvironmentVariables).map(([field, variable]) => [field, environment[variable]]),
  ));
}

export function applyRemoteOpenCodeEnvironment(
  environment: NodeJS.ProcessEnv,
  openCode: RemoteOpenCodeEnvironment,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const [field, variable] of Object.entries(openCodeEnvironmentVariables)) {
    const value = openCode[field as OpenCodeEnvironmentField];
    if (value === undefined) delete result[variable];
    else result[variable] = value;
  }
  return result;
}
