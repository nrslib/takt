import { useEffect, useState, useSyncExternalStore } from 'react';
import { OrderEditMediator } from './order-edit-mediator';

export function useOrderEditMediator(orderId: string) {
  const [mediator] = useState(() => new OrderEditMediator());
  const state = useSyncExternalStore(mediator.subscribe, mediator.getSnapshot);
  useEffect(() => mediator.load(orderId), [mediator, orderId]);
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || event.key !== 's') return;
      event.preventDefault();
      mediator.requestSave();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mediator]);
  return { ...state, requestSave: mediator.requestSave,
    handleSelectCustomer: mediator.handleSelectCustomer, handleAddLine: mediator.handleAddLine,
    handleChangeQuantity: mediator.handleChangeQuantity, handleRemoveLine: mediator.handleRemoveLine };
}
