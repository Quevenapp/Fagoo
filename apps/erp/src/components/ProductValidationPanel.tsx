import { useState } from 'react';
import { productIssues, type ValidationIssue } from '../lib/product-validation';
import { Icon } from './Icon';
import './product-registry.css';

// Painel "Validação do produto" do formulário (Origin): o card "Cadastro no Brufap" com Pendente/Pronto, atualizado ao digitar, e a
// "Compatibilidade" com as pendências (Verificar preço, Inserir nome, Inserir código, Inserir unidade); o lápis leva ao campo.
// Os cards de lojas virtuais do Origin ficam fora do escopo do Brufap. Só orienta: a gravação continua validada pelo servidor.
export function ProductValidationPanel({ values, sequential, onEdit }: { values: Record<string, string>; sequential?: boolean; onEdit: (key: ValidationIssue['key']) => void }) {
  const [open, setOpen] = useState(false), [expanded, setExpanded] = useState(true);
  const issues = productIssues(values, { sequential });
  const ready = issues.length === 0;
  if (!expanded) return <aside className="product-validation is-collapsed" aria-label="Validação do produto"><button type="button" className="icon-button" title="Expandir validação do produto" aria-label="Expandir validação do produto" onClick={() => setExpanded(true)}><Icon name="chevron-left" size={12} /></button></aside>;
  return <aside className="product-validation" aria-label="Validação do produto">
    <header><strong>Validação do produto</strong><button type="button" className="icon-button" title="Recolher validação do produto" aria-label="Recolher validação do produto" onClick={() => setExpanded(false)}><Icon name="chevron-right" size={12} /></button></header>
    {!open ? <button type="button" className="product-validation-card" onClick={() => setOpen(true)} aria-label={`Cadastro no FAGOO: ${ready ? 'Pronto' : 'Pendente'}`}>
      <span>Cadastro no FAGOO</span><span className={`product-validation-badge ${ready ? 'is-ready' : 'is-pending'}`}>{ready ? 'Pronto' : 'Pendente'}</span></button>
      : <div className="product-validation-detail"><button type="button" className="text-button" onClick={() => setOpen(false)}>‹ Compatibilidade</button>
        {ready ? <p className="real-help">Os campos obrigatórios do cadastro estão preenchidos.</p>
          : <ul>{issues.map(issue => <li key={issue.key}><span>{issue.label} *</span><button type="button" className="icon-button" title={issue.label} aria-label={issue.label} onClick={() => onEdit(issue.key)}><Icon name="pen-to-square" size={11} /></button></li>)}</ul>}</div>}
  </aside>;
}
