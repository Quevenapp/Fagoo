import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AccessError, type AccessController } from '../lib/real-access';
import { useUnsavedForm } from '../hooks/useUnsavedChanges';
import ContactTypes from './ContactTypes';
import RealSellers from './RealSellers';
import RealPaymentMethods from './RealPaymentMethods';
import RealEmployees from './RealEmployees';
import RealImportContacts from './RealImportContacts';
import { Icon } from './Icon';
import { CONFLICT_TEXT, aborted, errorText } from './catalog-shared';
import './contacts.css';

// Telas auxiliares de Cadastros da lane contatos, numa rota cada: Tipos de contatos, Vendedores, Formas de pagamento,
// Funcionários, Importar contatos e o Próximo número do código sequencial. Quem não tem acesso recebe a recusa da API.

export default function ContactModules({ controller, pathname, role }: { controller: AccessController; pathname: string; role: string }) {
  if (pathname === '/tipos-contatos-empresa') return <ContactTypes controller={controller} />;
  if (pathname === '/vendedores-empresa') return ['admin', 'consulta', 'vendas', 'financeiro'].includes(role) ? <RealSellers controller={controller} /> : <Denied title="Vendedores não liberados" text="Seu perfil não consulta os vendedores." />;
  if (pathname === '/formas-pagamento-empresa') return ['admin', 'consulta', 'vendas', 'financeiro'].includes(role) ? <RealPaymentMethods controller={controller} /> : <Denied title="Formas de pagamento não liberadas" text="Seu perfil não consulta as formas de pagamento." />;
  if (pathname === '/funcionarios-empresa') return role === 'admin' ? <RealEmployees controller={controller} /> : <Denied title="Funcionários não liberados" text="Somente administradores consultam os funcionários." />;
  if (pathname === '/importar-contatos') return ['admin', 'vendas', 'financeiro'].includes(role) ? <RealImportContacts controller={controller} /> : <Denied title="Importação não liberada" text="Seu perfil não inclui contatos." />;
  return <ContactNumbering controller={controller} />;
}
function Denied({ title, text }: { title: string; text: string }) { return <section className="real-state-panel"><h1>{title}</h1><p>{text}</p></section>; }

// Preferências > Configurações de clientes e fornecedores: "Código do Contato" e "Próximo número" com o lápis
// "Editar próximo número" (Origin PR-04). O número nunca volta para um código já usado.
type Code = { mode: 'manual' | 'sequencial'; next_number: string; version: number; highest_used: string; can_edit: boolean };
function ContactNumbering({ controller }: { controller: AccessController }) {
  const [code, setCode] = useState<Code | null>(null), [error, setError] = useState(''), [editing, setEditing] = useState(false), [value, setValue] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [command, setCommand] = useState<{ id: string; next: string; version: number; uncertain: boolean } | null>(null);
  const request = useRef<AbortController | null>(null), actor = useRef(controller.getSnapshot().membership?.user_id);
  const guard = useUnsavedForm(editing ? value : '', busy || Boolean(command?.uncertain));
  useEffect(() => {
    const current = new AbortController();
    void controller.catalog('/v1/cadastros/contatos/codigo', { signal: current.signal }).then(result => { if (!current.signal.aborted) setCode(result as Code); }).catch(failure => { if (!current.signal.aborted && !aborted(failure)) setError(errorText(failure)); });
    return () => { current.abort(); request.current?.abort(); };
  }, [controller]);
  const send = async (pending: { id: string; next: string; version: number; uncertain: boolean }) => {
    if (request.current) return;
    const current = new AbortController(); request.current = current; setBusy(true); setError(''); setCommand(pending);
    try {
      const result = await controller.catalog('/v1/cadastros/contatos/codigo', { method: 'PATCH', body: { command_id: pending.id, expected_version: pending.version, next_number: pending.next }, signal: current.signal }) as Code;
      if (current.signal.aborted || controller.getSnapshot().membership?.user_id !== actor.current) return;
      if (result.next_number !== pending.next && !(result as { replayed?: boolean }).replayed) throw new AccessError(502);
      setCode(result); setCommand(null); setEditing(false); setNotice('Próximo número salvo.');
    } catch (failure) {
      if (current.signal.aborted || aborted(failure)) return;
      if (!pending.uncertain && failure instanceof AccessError && [400, 403, 409].includes(failure.status)) { setCommand(null); setError(failure.status === 409 ? CONFLICT_TEXT : failure.status === 400 ? `O próximo número precisa ser maior que o maior código numérico já usado (${code?.highest_used ?? '0'}).` : errorText(failure)); }
      else { setCommand({ ...pending, uncertain: true }); setError('Não foi possível confirmar a alteração. Use “Conferir resultado” para repetir o mesmo comando.'); }
    } finally { if (request.current === current) { request.current = null; setBusy(false); } }
  };
  return <section className="contact-aux">
    <header className="real-heading catalog-heading"><div className="catalog-title"><h1>Código do contato</h1></div></header>
    {error && <p className="real-alert" role="alert">{error}</p>}{notice && <p className="real-success" role="status">{notice}</p>}
    {code && <dl className="contact-grid">
      <div><dt>Código do Contato</dt><dd>{code.mode === 'sequencial' ? 'Sequencial' : 'Manual'} · <Link to="/preferencias/cadastros/clientes-fornecedores">alterar em Preferências</Link></dd></div>
      <div><dt>Próximo número</dt><dd>{editing ? <span className="contact-person-search"><input id="contact-next-number" inputMode="numeric" maxLength={15} value={value} disabled={busy || Boolean(command?.uncertain)} onChange={event => setValue(event.target.value)} />
        {command?.uncertain ? <button type="button" className="primary-button" disabled={busy} onClick={() => void send(command)}>Conferir resultado</button>
          : <><button type="button" className="primary-button" disabled={busy || !/^[1-9]\d{0,14}$/.test(value.trim())} onClick={() => void send({ id: crypto.randomUUID(), next: value.trim(), version: code.version, uncertain: false })}>Salvar</button><button type="button" className="secondary-button" disabled={busy} onClick={() => guard.confirmLeave(() => setEditing(false))}>Cancelar</button></>}</span>
        : <>{code.next_number}{code.can_edit && <button type="button" className="icon-button" title="Editar próximo número" aria-label="Editar próximo número" onClick={() => { setValue(code.next_number); setEditing(true); setNotice(''); }}><Icon name="pencil" size={12} /></button>}</>}</dd></div>
    </dl>}
    <p className="real-help">Com “Código do Contato” em Sequencial, um contato incluído sem código recebe o próximo número; números já usados como código são pulados. Maior código numérico em uso: {code?.highest_used ?? '—'}.</p>
  </section>;
}
