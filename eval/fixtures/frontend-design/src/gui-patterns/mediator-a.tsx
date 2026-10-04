import { useReducer } from 'react';

type SaveState = {
  status: 'idle' | 'saving' | 'saved' | 'error';
  message: string;
};

type SaveEvent =
  | { type: 'started' }
  | { type: 'failed' };

const initialState: SaveState = { status: 'idle', message: '' };

function saveReducer(state: SaveState, event: SaveEvent): SaveState {
  if (event.type === 'started') return { status: 'saving', message: 'Saving' };
  return { status: 'error', message: 'Unable to save' };
}

export function Root({ save }: { save(value: string): Promise<void> }) {
  const [state, dispatch] = useReducer(saveReducer, initialState);

  async function handleSubmit(value: string) {
    if (state.status === 'saving') return;
    dispatch({ type: 'started' });
    try {
      await save(value);
    } catch {
      dispatch({ type: 'failed' });
    }
  }

  return <Screen state={state} onSubmit={handleSubmit} />;
}

function Screen({ state, onSubmit }: {
  state: SaveState;
  onSubmit(value: string): Promise<void>;
}) {
  return <SaveForm state={state} onSubmit={onSubmit} />;
}

function SaveForm({ state, onSubmit }: {
  state: SaveState;
  onSubmit(value: string): Promise<void>;
}) {
  return (
    <form onSubmit={(event) => {
      event.preventDefault();
      void onSubmit('Ada');
    }}>
      <button type="submit" disabled={state.status === 'saving'}>Save</button>
      <output role="status">{state.message || state.status}</output>
    </form>
  );
}
