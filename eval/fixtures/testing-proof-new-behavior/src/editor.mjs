export function createEditor(client, draft, selectedRoute, commit) {
  const state = {screen: 'editor', draft, selectedRoute, failed: false};
  return {
    state,
    async submit() {
      state.failed = false;
      try {
        await client.deliver(state.draft);
        commit();
        state.screen = 'complete';
      } catch {
        state.failed = true;
      }
    },
  };
}
