import { useCallback, useEffect, useReducer, useRef } from 'react';
import { getCustomers, getOrder, getProducts, saveOrder } from '../features/orders/api';
import {
  addLine,
  changeLineQuantity,
  hasOrderChanges,
  parseQuantity,
  removeLine,
} from '../features/orders/order-draft';
import type { Customer, Order, OrderLine, Product } from '../features/orders/types';

interface OrderData {
  customers: Customer[];
  products: Product[];
  saved: Order;
  draft: Order;
}

type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'failed'; message: string };

interface OrderEditState {
  data: OrderData | null;
  error: string | null;
  saveStatus: SaveStatus;
  inputError: string | null;
}

type OrderEditEvent =
  | { type: 'loading' }
  | { type: 'loaded'; data: OrderData }
  | { type: 'load-failed'; message: string }
  | { type: 'edited'; draft: Order }
  | { type: 'invalid-input'; message: string }
  | { type: 'save-started' }
  | { type: 'save-succeeded'; confirmed: Order }
  | { type: 'save-failed'; message: string };

const initialState: OrderEditState = {
  data: null, error: null, saveStatus: { kind: 'idle' }, inputError: null,
};
const QUANTITY_ERROR = '数量は1以上の整数で入力してください';

function orderEditReducer(state: OrderEditState, event: OrderEditEvent): OrderEditState {
  switch (event.type) {
    case 'loading':
      return initialState;
    case 'loaded':
      return { ...initialState, data: event.data };
    case 'load-failed':
      return { ...state, error: event.message };
    case 'edited':
      if (!state.data || state.saveStatus.kind === 'saving') return state;
      return { ...state, data: { ...state.data, draft: event.draft }, inputError: null, saveStatus: { kind: 'idle' } };
    case 'invalid-input':
      return { ...state, inputError: event.message };
    case 'save-started':
      return { ...state, saveStatus: { kind: 'saving' }, inputError: null };
    case 'save-succeeded':
      if (!state.data) return state;
      return {
        ...state, data: { ...state.data, saved: event.confirmed, draft: event.confirmed }, saveStatus: { kind: 'saved' },
      };
    case 'save-failed':
      return { ...state, saveStatus: { kind: 'failed', message: event.message } };
  }
}

export function useOrderEditPage(orderId: string) {
  const [state, dispatch] = useReducer(orderEditReducer, initialState);
  const { data } = state;
  const saving = useRef(false);

  useEffect(() => {
    let active = true;
    dispatch({ type: 'loading' });
    Promise.all([getOrder(orderId), getCustomers(), getProducts()]).then(
      ([order, customers, products]) => {
        if (active) dispatch({ type: 'loaded', data: { customers, products, saved: order, draft: order } });
      },
      (error: unknown) => {
        if (active) dispatch({ type: 'load-failed', message: error instanceof Error ? error.message : '読み込みに失敗しました' });
      },
    );
    return () => { active = false; };
  }, [orderId]);

  const requestSave = useCallback(() => {
    if (saving.current || !data || !hasOrderChanges(data.saved, data.draft)) return;
    saving.current = true;
    dispatch({ type: 'save-started' });
    saveOrder(data.draft).then(
      confirmed => {
        saving.current = false;
        dispatch({ type: 'save-succeeded', confirmed });
      },
      (error: unknown) => {
        saving.current = false;
        dispatch({ type: 'save-failed', message: error instanceof Error ? error.message : '保存に失敗しました' });
      },
    );
  }, [data]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || event.key !== 's') return;
      event.preventDefault();
      requestSave();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [requestSave]);

  const applyDraft = (draft: Order) => dispatch({ type: 'edited', draft });
  const applyLines = (lines: OrderLine[]) => {
    if (data) applyDraft({ ...data.draft, lines });
  };

  const handleSelectCustomer = (customerId: string) => {
    if (saving.current || !data) return;
    applyDraft({ ...data.draft, customerId });
  };

  const handleAddLine = (productId: string, quantity: string) => {
    if (saving.current || !data) return;
    if (!productId) {
      dispatch({ type: 'invalid-input', message: '商品を選択してください' });
      return;
    }
    const parsed = parseQuantity(quantity);
    if (parsed === null) {
      dispatch({ type: 'invalid-input', message: QUANTITY_ERROR });
      return;
    }
    applyLines(addLine(data.draft.lines, productId, parsed));
  };

  const handleChangeQuantity = (productId: string, quantity: string) => {
    if (saving.current || !data) return;
    const parsed = parseQuantity(quantity);
    if (parsed === null) {
      dispatch({ type: 'invalid-input', message: QUANTITY_ERROR });
      return;
    }
    applyLines(changeLineQuantity(data.draft.lines, productId, parsed));
  };

  const handleRemoveLine = (productId: string) => {
    if (saving.current || !data) return;
    applyLines(removeLine(data.draft.lines, productId));
  };

  return { ...state, requestSave, handleSelectCustomer, handleAddLine, handleChangeQuantity, handleRemoveLine };
}
