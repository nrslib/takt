import { createContext, useContext, useReducer, type Dispatch, type PropsWithChildren } from 'react';

type SelectionAction = { type: 'selected'; id: string };
type SelectionState = { selectedId: string | null };

const SelectionDispatchContext = createContext<Dispatch<SelectionAction> | null>(null);

function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  if (action.type === 'selected') return { selectedId: action.id };
  return state;
}

export function SelectionProvider({ children }: PropsWithChildren) {
  const [state, dispatch] = useReducer(selectionReducer, { selectedId: null });

  return (
    <SelectionDispatchContext.Provider value={dispatch}>
      <output>{state.selectedId ?? 'none'}</output>
      {children}
    </SelectionDispatchContext.Provider>
  );
}

export function UserSelectionButton({ userId }: { userId: string }) {
  const dispatch = useContext(SelectionDispatchContext);
  if (dispatch === null) throw new Error('SelectionProvider is required');

  return (
    <button type="button" onClick={() => dispatch({ type: 'selected', id: userId })}>
      Select user
    </button>
  );
}
