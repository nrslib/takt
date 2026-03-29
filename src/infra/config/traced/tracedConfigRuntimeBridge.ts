import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import type { SchemaShape, TracedValue } from 'traced-config';

type SerializedSchemaFormat = 'string' | 'number' | 'boolean' | 'json' | undefined;

type SerializedSchemaEntry = {
  default?: unknown;
  doc: string;
  format?: SerializedSchemaFormat;
  env?: string;
  sources?: {
    global?: boolean;
    local?: boolean;
    env?: boolean;
    cli?: boolean;
  };
};

type RuntimeLoadInput = {
  schemaGroups: Array<Record<string, SerializedSchemaEntry>>;
  fileOrigin: 'global' | 'local';
  tempConfigPath?: string;
};

type RuntimeLoadOutput = {
  traceEntries: Array<[string, TracedValue<unknown>]>;
};

function serializeSchema(schema: SchemaShape): Record<string, SerializedSchemaEntry> {
  const serialized: Record<string, SerializedSchemaEntry> = {};
  for (const [key, entry] of Object.entries(schema)) {
    let format: SerializedSchemaFormat;
    if (entry.format === String) format = 'string';
    else if (entry.format === Number) format = 'number';
    else if (entry.format === Boolean) format = 'boolean';
    else if (entry.format === 'json') format = 'json';
    else format = undefined;

    serialized[key] = {
      default: entry.default,
      doc: entry.doc,
      format,
      env: entry.env,
      sources: entry.sources,
    };
  }
  return serialized;
}

function hasSchemaCollision(schemaKeys: readonly string[], key: string): boolean {
  return schemaKeys.some((candidate) =>
    candidate === key || candidate.startsWith(`${key}.`) || key.startsWith(`${candidate}.`),
  );
}

function partitionSchema(schema: SchemaShape): SchemaShape[] {
  const groups: SchemaShape[] = [];
  for (const [key, entry] of Object.entries(schema)) {
    const group = groups.find((candidate) => !hasSchemaCollision(Object.keys(candidate), key));
    if (group) {
      group[key] = entry;
      continue;
    }
    groups.push({ [key]: entry });
  }
  return groups;
}

const TRACED_CONFIG_RUNTIME_SCRIPT = `
import { readFileSync } from 'node:fs';
import { tracedConfig } from 'traced-config';

const input = JSON.parse(readFileSync(0, 'utf8'));
const traceEntries = [];
for (const schemaGroup of input.schemaGroups) {
  const schema = {};
  for (const [key, entry] of Object.entries(schemaGroup)) {
    let format;
    if (entry.format === 'string') format = String;
    else if (entry.format === 'number') format = Number;
    else if (entry.format === 'boolean') format = Boolean;
    else if (entry.format === 'json') format = 'json';
    schema[key] = {
      default: entry.default,
      doc: entry.doc,
      format,
      env: entry.env,
      sources: entry.sources,
    };
  }

  const config = tracedConfig({
    defaultSources: { env: false, cli: false },
    schema,
  });

  if (input.tempConfigPath) {
    await config.loadFile([{ path: input.tempConfigPath, label: input.fileOrigin }]);
  }

  for (const key of Object.keys(schema)) {
    traceEntries.push([key, config.getTraced(key)]);
  }
}
process.stdout.write(JSON.stringify({ traceEntries }));
`;

export function loadTraceEntriesViaRuntime(
  schema: SchemaShape,
  fileOrigin: 'global' | 'local',
  parsedConfig: Record<string, unknown>,
): Map<string, TracedValue<unknown>> {
  const tempDir = mkdtempSync(join(tmpdir(), 'takt-traced-config-'));

  try {
    const tempConfigPath = Object.keys(parsedConfig).length > 0
      ? join(tempDir, 'config.yaml')
      : undefined;
    if (tempConfigPath) {
      writeFileSync(tempConfigPath, stringifyYaml(parsedConfig), 'utf-8');
    }

    const input: RuntimeLoadInput = {
      schemaGroups: partitionSchema(schema).map((schemaGroup) => serializeSchema(schemaGroup)),
      fileOrigin,
      tempConfigPath,
    };
    const stdout = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', TRACED_CONFIG_RUNTIME_SCRIPT],
      {
        cwd: process.cwd(),
        env: process.env,
        input: JSON.stringify(input),
        encoding: 'utf-8',
      },
    );
    const result = JSON.parse(stdout) as RuntimeLoadOutput;
    const traceEntries = new Map<string, TracedValue<unknown>>();
    for (const [key, traced] of result.traceEntries) {
      traceEntries.set(key, traced);
    }
    return traceEntries;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
