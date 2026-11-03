import { mirrorDecimal, type DocumentOriginTotals as OriginTotals } from '../lib/document-mirror-model';

export default function DocumentOriginTotals({ totals }: { totals: OriginTotals }) {
  return <div className="document-origin-totals">{(['origin', 'brufap'] as const).map(origin => {
    const value = totals[origin];
    return value.count > 0 && <section key={origin} aria-label={`Total origem ${origin === 'origin' ? 'Origin' : 'FAGOO'}`}><dl className="native-list-stat"><dt>{origin === 'origin' ? 'Origin · valor informado' : 'FAGOO · valor total'}</dt><dd>{mirrorDecimal(value.total, true)}</dd></dl><p className="real-help">{value.count.toLocaleString('pt-BR')} documento(s) · {value.known_total_count.toLocaleString('pt-BR')} com valor informado.{value.known_total_count < value.count ? ' Cobertura parcial; total indisponível.' : ''}</p></section>;
  })}</div>;
}
