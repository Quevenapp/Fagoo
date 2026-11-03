export type EditorState = Readonly<{ dirty: boolean; busy: boolean }>;
const CLEAN: EditorState = Object.freeze({ dirty: false, busy: false });

/** In-memory flags only. Never retain fields, document identifiers or request payloads. */
export function createUnsavedChangesStore() {
  const editors = new Map<symbol, EditorState>();
  const subscribers = new Set<() => void>();
  let snapshot = CLEAN, bypass = 0;
  const publish = () => {
    const dirty = [...editors.values()].some(value => value.dirty);
    const busy = [...editors.values()].some(value => value.busy);
    if (dirty === snapshot.dirty && busy === snapshot.busy) return;
    snapshot = Object.freeze({ dirty, busy });
    subscribers.forEach(listener => listener());
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
    update(id: symbol, state: EditorState) { editors.set(id, { dirty: Boolean(state.dirty), busy: Boolean(state.busy) }); publish(); },
    remove(id: symbol) { editors.delete(id); publish(); },
    shouldBlock: () => bypass === 0 && (snapshot.dirty || snapshot.busy),
    /** Only the already-confirmed synchronous action may initiate an unblocked route change. */
    runConfirmed(action: () => void) { bypass++; try { action(); } finally { bypass--; } },
  };
}

/** Native reload/tab-close warning; the browser chooses the text and whether to show it. */
export function protectBeforeUnload(target: EventTarget, shouldBlock: () => boolean) {
  const listener = (event: Event) => {
    if (!shouldBlock()) return;
    event.preventDefault(); (event as BeforeUnloadEvent).returnValue = '';
  };
  target.addEventListener('beforeunload', listener);
  return () => target.removeEventListener('beforeunload', listener);
}
