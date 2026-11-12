import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const cliUrl = new URL('../../dist/app/cli/index.js', import.meta.url).href;

async function renderThroughEntry(entry: string, nodeEnv: string | undefined): Promise<{
  nodeEnv: string | null;
  childNodeEnv: string | null;
  measures: number[];
  rendered: boolean;
}> {
  const entryUrl = new URL(`../../${entry}`, import.meta.url).href;
  const interceptedUrl = entry === 'bin/takt' ? cliUrl : entryUrl;
  const env = { ...process.env };
  if (nodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = nodeEnv;

  const probe = `
    {
    const { jsx } = await import('react/jsx-runtime');
    const { render, Text } = await import('ink');
    const { Writable } = await import('node:stream');
    const { setImmediate } = await import('node:timers/promises');
    let output = '';
    const stdout = new Writable({ write(chunk, encoding, callback) {
      output += chunk.toString();
      callback();
    } });
    stdout.columns = 80;
    const app = render(jsx(Text, { children: 'frame-0' }), {
      stdout, stderr: stdout, debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    const measures = [];
    try {
      for (let batch = 0; batch < 3; batch++) {
        for (let frame = 0; frame < 10; frame++) {
          app.rerender(jsx(Text, { children: 'frame-' + (batch * 10 + frame) }));
          await setImmediate();
        }
        await app.waitUntilRenderFlush();
        measures.push(performance.getEntriesByType('measure').length);
      }
    } finally {
      app.unmount();
      await app.waitUntilExit();
      app.cleanup();
    }
    const { execFileSync } = await import('node:child_process');
    const { buildChildProcessEnv } = await import(${JSON.stringify(new URL('../../dist/shared/utils/child-process-env.js', import.meta.url).href)});
    const childNodeEnv = JSON.parse(execFileSync(process.execPath, [
      '-e', 'process.stdout.write(JSON.stringify(process.env.NODE_ENV ?? null))',
    ], { env: buildChildProcessEnv(), encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' }));
    console.log(JSON.stringify({ nodeEnv: process.env.NODE_ENV ?? null, childNodeEnv, measures,
      rendered: output.includes('frame-29') }));
    process.exit(0);
    }
  `;

  // 実際の静的依存を評価した後、daemon 起動などの入口本体だけを描画計測へ置き換える。
  const preload = `
    import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (url !== ${JSON.stringify(interceptedUrl)}) return loaded;
      const source = typeof loaded.source === 'string'
        ? loaded.source : Buffer.from(loaded.source).toString('utf8');
      return { ...loaded, source: ${JSON.stringify(probe)} + source.replace(/^#![^\\n]*\\n/, '') };
    } });
  `;
  const { stdout } = await execute(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(preload)}`, fileURLToPath(entryUrl),
  ], {
    env, timeout: 15_000, killSignal: 'SIGKILL',
  });
  return JSON.parse(stdout);
}

describe('CLI React runtime', () => {
  it.each([
    'bin/takt',
    'dist/app/cli/index.js',
    'dist/app/daemon/index.js',
    'dist/app/daemon-turn/index.js',
    'dist/app/acp/index.js',
    'dist/app/mcp/index.js',
  ])('should avoid accumulating render measures when NODE_ENV is unset: %s', async (entry) => {
    const result = await renderThroughEntry(entry, undefined);

    expect(result.rendered).toBe(true);
    expect(result.measures).toEqual([0, 0, 0]);
    expect(result.nodeEnv).toBeNull();
    expect(result.childNodeEnv).toBeNull();
  });

  it.each(['production', 'development', 'test', ''])('should preserve explicit NODE_ENV=%j', async (nodeEnv) => {
    const result = await renderThroughEntry('dist/app/cli/index.js', nodeEnv);

    expect(result.rendered).toBe(true);
    expect(result.nodeEnv).toBe(nodeEnv);
    expect(result.childNodeEnv).toBe(nodeEnv);
    if (nodeEnv === 'production') {
      expect(result.measures).toEqual([0, 0, 0]);
    } else {
      expect(result.measures[1]).toBeGreaterThan(result.measures[0]!);
      expect(result.measures[2]).toBeGreaterThan(result.measures[1]!);
    }
  });

  it('should restore unset NODE_ENV when preloading fails', async () => {
    const env = { ...process.env };
    delete env.NODE_ENV;
    const script = `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === 'react/jsx-runtime') throw new Error('preload failed');
        return nextResolve(specifier, context);
      } });
      let failed = false;
      try {
        await import(${JSON.stringify(new URL('../../dist/app/environment.js', import.meta.url).href)});
      } catch (error) {
        if (error.message !== 'preload failed') throw error;
        failed = true;
      }
      console.log(JSON.stringify({ failed, nodeEnv: process.env.NODE_ENV ?? null }));
    `;

    const { stdout } = await execute(process.execPath, ['--input-type=module', '--eval', script], {
      env, timeout: 5000, killSignal: 'SIGKILL',
    });

    expect(JSON.parse(stdout)).toEqual({ failed: true, nodeEnv: null });
  });
});
