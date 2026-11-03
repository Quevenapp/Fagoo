/** Synthetic exercise imported exclusively by qa.tsx; never part of the production build. */
import { useState } from 'react';
import { useUnsavedForm } from '../hooks/useUnsavedChanges';
export default function UnsavedChangesQA() {
  const [value,setValue]=useState(''),[busy,setBusy]=useState(false);
  const guard=useUnsavedForm({value},busy);
  return <section className="real-editor"><h1>Proteção de formulários · QA fictícia</h1><p>Este exercício não grava nem envia dados. Use os botões superiores para testar a saída.</p>
    <div className="form-field"><label htmlFor="guard-qa-value">Texto de teste de proteção</label><input id="guard-qa-value" value={value} onChange={event=>setValue(event.target.value)} disabled={busy}/></div>
    <p role="status">{busy?'Operação fictícia pendente':'Nenhuma operação pendente'}</p>
    <div className="real-editor-actions"><button className="primary-button" disabled={busy} onClick={()=>setBusy(true)}>Simular operação pendente</button><button className="secondary-button" disabled={!busy} onClick={()=>setBusy(false)}>Concluir operação fictícia</button><button className="secondary-button" onClick={()=>guard.confirmLeave(()=>{setValue('');setBusy(false);})}>Descartar exercício</button><a className="secondary-button" href="/qa.html">Recarregar página de teste</a></div>
  </section>;
}
