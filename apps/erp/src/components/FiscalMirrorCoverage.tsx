import type { FiscalMirrorCoverage as FiscalCoverage } from '../../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
const moment = (value: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
export default function FiscalMirrorCoverage({ coverage }: { coverage?: FiscalCoverage | null }) {
  if (!coverage) return <p className="real-help">Consulte o horário de observação na nota. A cobertura da sincronização ainda não foi informada nesta consulta.</p>;
  return <section className="fiscal-mirror-coverage" aria-label="Cobertura do espelho fiscal">
    <h2>{coverage.partial ? 'Cobertura parcial do espelho' : 'Cobertura do espelho'}</h2>
    <dl>{([['Registros coletados', coverage.source_count], ['Notas visíveis', coverage.visible_count], ['Com XML coletado', coverage.xml_count], ['XML pendente', coverage.missing_xml_count]] as const).map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{count.toLocaleString('pt-BR')}</dd></div>)}</dl>
    <p className="real-help">Contagem geral deste modelo e direção, dentro do seu acesso. Os filtros de pesquisa não alteram esses números. {coverage.homologation_count} registro(s) de homologação ficam fora da lista operacional; {coverage.duplicate_count} duplicata(s) por chave não são contadas de novo.{Boolean(coverage.incomplete_count) && <> {coverage.incomplete_count} nota(s) têm dados incompletos na fonte.</>}</p>
    <p className="real-help">{coverage.oldest_observed_at && coverage.latest_observed_at ? <>Observações entre <time dateTime={coverage.oldest_observed_at}>{moment(coverage.oldest_observed_at)}</time> e <time dateTime={coverage.latest_observed_at}>{moment(coverage.latest_observed_at)}</time>, horário de São Paulo.</> : 'Nenhum horário de observação disponível.'} Estes números conferem o material coletado; não comprovam que o Origin esteja integralmente atualizado.</p>
  </section>;
}
