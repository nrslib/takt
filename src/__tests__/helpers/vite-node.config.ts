/**
 * Config for spawning vite-node against TypeScript sources in tests.
 *
 * Without an explicit esbuild target, vite-node keeps `using` declarations
 * (explicit resource management) as raw syntax, which only Node >= 24 can
 * parse. Targeting the engines floor lowers them so the spawned entrypoint
 * runs on every supported Node version.
 */
export default {
  esbuild: {
    target: 'node22',
  },
};
