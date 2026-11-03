import { Component, Suspense, type ReactNode } from 'react';
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChanges';

class ModuleErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/** Auth, navigation and the shared draft guard stay outside this route-only boundary. */
export default function NativeModuleBoundary({ children, resetKey, label = 'Carregando módulo…' }: { children: ReactNode; resetKey: string; label?: string }) {
  const guard = useUnsavedChangesGuard();
  const failure = <section className="empty-state" role="alert">
    <h2>Não foi possível abrir esta tela</h2>
    <p>Confira sua conexão e recarregue a página para tentar novamente.</p>
    <button type="button" className="secondary-button" onClick={() => guard.confirmLeave(() => window.location.reload())}>Recarregar página</button>
  </section>;
  // A rejected lazy import is cached by React; only an explicit page reload retries it.
  // Ordinary route changes reset this boundary without resetting the auth controller.
  return <ModuleErrorBoundary key={resetKey} fallback={failure}>
    <Suspense fallback={<section className="empty-state" role="status" aria-live="polite">{label}</section>}>{children}</Suspense>
  </ModuleErrorBoundary>;
}
