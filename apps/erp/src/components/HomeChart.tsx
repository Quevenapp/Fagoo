import {useId} from 'react';
import {financeMoney} from '../lib/real-finance-model';
import {homeAxisMoney,homeBarPath,homeBucketLabel,homeChart,homeChartUpdated,homePeriodText,type HomePeriod} from '../lib/home-model';

// Gráfico do "Resumo diário" desenhado em SVG local (sem bibliotecas; a CSP só permite recursos locais).
// Barras agrupadas por dia (até 62 dias) ou por mês, um único eixo em reais, legenda e tabela de dados.
export function HomeChart({period,hidden,asOf}:{period:HomePeriod;hidden:boolean;asOf?:string}){
  const chart=homeChart(period),titleId=useId(),tableId=useId();
  const money=(cents:string)=>hidden?'R$ ••••':financeMoney(cents);
  const unit=period.grain==='day'?'dia':'mês';
  return <figure className="home-chart" aria-labelledby={titleId}>
    <figcaption className="home-chart-head"><span id={titleId}>Valores por {unit} · {homePeriodText(period)}</span>{asOf&&<small className="home-chart-updated">{homeChartUpdated(asOf)}</small>}
      {chart.series.length>1&&<ul className="home-chart-legend" aria-label="Legenda">{chart.series.map(item=><li key={item.key}><span className={`home-swatch home-series-${item.key}`} aria-hidden="true"/>{item.label}</li>)}</ul>}
    </figcaption>
    {chart.empty?<p className="home-chart-empty">Nenhum valor registrado no período.</p>:
    <svg className="home-chart-svg" viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label={`Valores por ${unit}: ${chart.series.map(item=>item.label).join(', ')}. Os números estão na tabela de dados.`}>
      {chart.ticks.map(tick=><g key={tick.cents} className="home-chart-tick"><line x1={chart.left} x2={chart.width-8} y1={tick.y} y2={tick.y}/><text x={chart.left-6} y={tick.y} dy="0.32em" textAnchor="end">{hidden?(tick.cents==='0'?'R$ 0':'••••'):homeAxisMoney(tick.cents)}</text></g>)}
      {chart.groups.map(group=><g key={group.bucket} className="home-chart-group">
        {group.bars.map(bar=>bar.height>0&&<path key={bar.series} className={`home-series-${bar.series}`} d={homeBarPath(bar)}/>)}
        {group.label&&<text className="home-chart-label" x={group.x+group.width/2} y={chart.height-8} textAnchor="middle">{group.label}</text>}
        <rect className="home-chart-hit" x={group.x} y={chart.top} width={group.width} height={chart.height-chart.top-chart.bottom}><title>{`${group.title} — ${group.bars.map(bar=>`${chart.series.find(item=>item.key===bar.series)!.label}: ${money(bar.cents)}`).join('; ')}`}</title></rect>
      </g>)}
    </svg>}
    <details className="home-chart-data"><summary aria-controls={tableId}>Ver dados do gráfico</summary>
      <table id={tableId}><thead><tr><th scope="col">{period.grain==='day'?'Dia':'Mês'}</th>{chart.series.map(item=><th scope="col" key={item.key}>{item.label}</th>)}</tr></thead>
        <tbody>{period.points.map(point=><tr key={point.bucket}><th scope="row">{homeBucketLabel(point.bucket,period.grain,true)}</th>{chart.series.map(item=><td key={item.key}>{money(point[item.field]??'0')}</td>)}</tr>)}</tbody></table>
    </details>
  </figure>;
}
