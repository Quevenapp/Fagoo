import { useEffect, useState } from 'react';
import { AccessError } from '../lib/real-access';
import { numberingListPath, numberingPage, type FiscalNumberingController, type NumberingModel, type NumberingSeries } from '../lib/fiscal-numbering-model';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const cnpj = (value: string) => value.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');

/**
 * "Controle de numeração" of Preferências › Configurações de NF-e / NFC-e: the CNPJ | Série | Próximo número table of Origin,
 * read from the homologation series (migration 046). Production series stay locked until the production numbering decision.
 */
export default function FiscalNumberingSummary({ read, model }: { read: FiscalNumberingController['fiscalNumbering']; model: NumberingModel }) {
  const [rows, setRows] = useState<NumberingSeries[] | null>(null), [error, setError] = useState('');
  useEffect(() => {
    const request = new AbortController();
    void Promise.resolve().then(() => read(numberingListPath(model), { signal: request.signal })).then(value => { if (!request.signal.aborted) setRows(numberingPage(value, model).items); })
      .catch(problem => { if (!request.signal.aborted && !aborted(problem)) setError(problem instanceof AccessError && problem.status === 403 ? 'Seu perfil não consulta as séries fiscais.' : 'Não foi possível consultar as séries fiscais.'); });
    return () => request.abort();
  }, [read, model]);
  if (error) return <p className="preference-note">{error}</p>;
  if (!rows) return <p className="preference-note" role="status">Consultando as séries…</p>;
  if (!rows.length) return <p className="preference-note">Nenhuma série de homologação cadastrada.</p>;
  return <table className="data-table preference-numbering"><thead><tr><th scope="col">CNPJ</th><th scope="col">Série</th><th scope="col">Próximo número</th><th scope="col">Ambiente</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.id}><td>{cnpj(row.issuer_cnpj)}</td><td>{row.series}</td><td>{row.next_number ?? 'Esgotada'}</td><td>Homologação{row.enabled ? '' : ' · desativada'}</td></tr>)}</tbody></table>;
}
