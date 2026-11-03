import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useBlocker } from 'react-router-dom';
import { createUnsavedChangesStore, protectBeforeUnload } from '../lib/unsaved-changes-store';
import './unsaved-changes.css';

type Guard = { store: ReturnType<typeof createUnsavedChangesStore>; confirmLeave: (action: () => void) => void };
const Context = createContext<Guard | null>(null);

function Confirmation({ busy, onStay, onLeave }: { busy: boolean; onStay: () => void; onLeave: () => void }) {
  const ref = useRef<HTMLDialogElement>(null), title = useId();
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current; dialog?.showModal();
    return () => { dialog?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog className="unsaved-confirm" ref={ref} aria-labelledby={title} onCancel={event => { event.preventDefault(); onStay(); }}>
    <h2 id={title}>{busy ? 'Sair durante a operação?' : 'Descartar alterações não salvas?'}</h2>
    <p>{busy ? 'Uma operação está em andamento. Sair interrompe a confirmação na tela, mas ela pode já ter sido registrada. Confira o resultado na listagem antes de repetir.' : 'As alterações deste formulário ainda não foram salvas. Você pode continuar a edição ou sair e descartá-las.'}</p>
    <div className="unsaved-actions"><button type="button" className="primary-button" autoFocus onClick={onStay}>Continuar na tela</button><button type="button" className="secondary-button" onClick={onLeave}>{busy ? 'Sair mesmo assim' : 'Descartar e sair'}</button></div>
  </dialog>;
}

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createUnsavedChangesStore);
  const flags = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [pendingAction, setPendingAction] = useState<{ run: () => void } | null>(null);
  const pendingRef = useRef(pendingAction); pendingRef.current = pendingAction;
  const blocker = useBlocker(useCallback(() => store.shouldBlock(), [store]));
  const blockerRef = useRef(blocker); blockerRef.current = blocker;
  const confirmLeave = useCallback((action: () => void) => {
    if (pendingRef.current || blockerRef.current.state !== 'unblocked') return;
    if (!store.shouldBlock()) { action(); return; }
    const pending = { run: action }; pendingRef.current = pending; setPendingAction(pending);
  }, [store]);
  const guard = useMemo(() => ({ store, confirmLeave }), [store, confirmLeave]);
  useEffect(() => {
    if (!flags.dirty && !flags.busy) return;
    return protectBeforeUnload(window, store.shouldBlock);
  }, [store, flags.dirty, flags.busy]);
  // A save completion or permission revocation never runs a stale pending action.
  useEffect(() => {
    if (flags.dirty || flags.busy) return;
    if (pendingRef.current) { pendingRef.current = null; setPendingAction(null); }
    if (blockerRef.current.state === 'blocked') blockerRef.current.reset();
  }, [flags.dirty, flags.busy]);
  const stay = () => {
    pendingRef.current = null; setPendingAction(null);
    if (blocker.state === 'blocked') blocker.reset();
  };
  const leave = () => {
    const action = pendingRef.current; pendingRef.current = null; setPendingAction(null);
    if (action) store.runConfirmed(action.run);
    else if (blocker.state === 'blocked') blocker.proceed();
  };
  const show = (flags.dirty || flags.busy) && (pendingAction !== null || blocker.state === 'blocked');
  return <Context.Provider value={guard}>{children}{show && <Confirmation busy={flags.busy} onStay={stay} onLeave={leave} />}</Context.Provider>;
}

export function useUnsavedChangesGuard() {
  const guard = useContext(Context);
  if (!guard) throw new Error('UNSAVED_CHANGES_PROVIDER_REQUIRED');
  return guard;
}

/** Baselines remain in the editor; the shared guard receives only boolean flags. */
export function useUnsavedChanges(dirty: boolean, busy = false) {
  const guard = useUnsavedChangesGuard();
  const [id] = useState(() => Symbol('editor'));
  useLayoutEffect(() => { guard.store.update(id, { dirty, busy }); }, [guard.store, id, dirty, busy]);
  useLayoutEffect(() => () => guard.store.remove(id), [guard.store, id]);
  return guard;
}

/** For editors remounted after saving: compare with their initial in-memory values. */
export function useUnsavedForm(value: unknown, busy = false) {
  const serialized = JSON.stringify(value);
  const [baseline] = useState(serialized);
  return useUnsavedChanges(serialized !== baseline, busy);
}
