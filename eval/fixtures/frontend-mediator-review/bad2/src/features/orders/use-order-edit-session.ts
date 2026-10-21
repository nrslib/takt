import { useEffect, useState, useSyncExternalStore } from 'react';
import { OrderEditSession } from './order-edit-session';

export function useOrderEditSession(orderId: string) {
  const [session] = useState(() => new OrderEditSession());
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => session.load(orderId), [session, orderId]);
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || event.key !== 's') return;
      event.preventDefault();
      session.requestSave();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [session]);
  return { ...state, requestSave: session.requestSave,
    handleSelectCustomer: session.handleSelectCustomer, handleAddLine: session.handleAddLine,
    handleChangeQuantity: session.handleChangeQuantity, handleRemoveLine: session.handleRemoveLine };
}
