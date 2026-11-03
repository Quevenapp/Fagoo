// One finance command with the "Conferir resultado" contract: the command id and body are kept until a definitive
// answer; an uncertain one (timeout, 5xx, network) is repeated as is, never with a new id.
import { useRef, useState } from 'react';
import { AccessError } from '../lib/real-access';

export type FinanceCommand = { id: string; path: string; data: Record<string, unknown> };
export const definitiveFailure = (failure: unknown) => failure instanceof AccessError && [400, 403, 404, 409].includes(failure.status);
export function useFinanceCommand(send: (command: FinanceCommand) => Promise<unknown>, mayWrite: () => boolean, describe: (failure: unknown) => string) {
  const [state, setState] = useState<{ busy: boolean; uncertain: boolean; error: string }>({ busy: false, uncertain: false, error: '' }), pending = useRef<FinanceCommand | null>(null);
  const run = async (build: () => FinanceCommand, onDone: (value: unknown) => void) => {
    if (state.busy) return;
    if (!mayWrite()) { setState({ ...state, error: 'Seu acesso a esta operação foi alterado.' }); return; }
    if (!pending.current) { try { pending.current = build(); } catch (failure) { setState({ ...state, error: (failure as Error).message }); return; } }
    const command = pending.current, replay = state.uncertain; setState({ busy: true, uncertain: replay, error: '' });
    try { const value = await send(command); pending.current = null; setState({ busy: false, uncertain: false, error: '' }); onDone(value); }
    catch (failure) {
      if (definitiveFailure(failure) && !replay) { pending.current = null; setState({ busy: false, uncertain: false, error: describe(failure) }); }
      else setState({ busy: false, uncertain: true, error: definitiveFailure(failure) ? `${describe(failure)} O envio anterior continua sem confirmação.` : 'Não foi possível confirmar o resultado. Use “Conferir resultado” para repetir a mesma operação; ela não será duplicada.' });
    }
  };
  return { ...state, run, locked: state.busy || state.uncertain };
}
