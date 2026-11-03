import { Link, useSearchParams } from 'react-router-dom';
import { Icon } from './Icon';
import './reports-catalog.css';

type Report = { title: string; description: string; chart?: boolean; to?: string };
type ReportArea = { id: string; label: string; groups: readonly { title?: string; reports: readonly Report[] }[] };

// Origin "Relatório de <módulo>" catalog (relatorios.php?id=..), transcribed on 19/10/2026.
export const REPORT_AREAS: readonly ReportArea[] = [
  { id: 'Cadastros', label: 'Cadastros', groups: [{ title: 'Controle de Lotes', reports: [{ title: 'Relatório Controle de Lotes', description: 'Relatório de controle de Lotes.' }] }, { title: 'Produtos', reports: [{ title: 'Relatório de preço de produtos', description: 'Impressão da lista de preços agrupada por categorias.' }] }] },
  { id: 'Estoque', label: 'Suprimentos', groups: [
    { title: 'Controle de Estoque', reports: [{ title: 'Entradas e Saídas de Estoque', description: 'Este relatório mostra todas as entradas e saídas realizadas em um período. Demonstra o fluxo de movimentação do estoque e os saldos no período.' }, { title: 'Relatório Transferência de Estoque', description: 'Este relatório exibe a transferência de estoque realizada em um período.' }, { title: 'Relatório de Saldos em Estoque', description: 'Apresenta os saldos em estoque dos itens em uma data qualquer.' }, { title: 'Relatório de Produtos com Maior Circulação', description: 'Relação dos itens que mais movimentaram em certo período e a sua participação percentual com totais por quantidade e valor.' }, { title: 'Relatório de Produtos sem Movimentação', description: 'Relaciona os produtos que não tiveram nenhuma movimentação no período.' }, { title: 'Relatório de Produtos Abaixo do Estoque Mínimo', description: 'Relação dos produtos que estão abaixo do estoque mínimo.' }, { title: 'Relatório de Visão Financeira do Estoque', description: 'Valor total dos produtos em estoque pelo preço de última compra e preço de venda.' }, { title: 'Relatório de Movimentação de um Produto', description: 'Relatório e gráfico de movimentação de estoque de um produto em determinado período.', chart: true }] },
    { title: 'Notas de Entrada', reports: [{ title: 'Notas Fiscais de Compra por Operação', description: 'Relação de notas de compra agrupadas pela natureza da operação.' }, { title: 'Relatório de Notas Fiscais por Fornecedor', description: 'Fornece o valor total de notas de compras agrupado pelo fornecedor.' }, { title: 'Relatório de Notas Fiscais de Compra por Produto', description: 'Fornece o valor total de notas de compras agrupado pelo produto.' }, { title: 'Relatório de Evolução de Notas Fiscais de Compra', description: 'Relatório e gráfico da evolução do total de compras no período informado.', chart: true }] },
    { title: 'Pedidos de Compra', reports: [{ title: 'Relatório de Pedidos de Compras', description: 'Relatório que permite agrupamento por cliente, produto.' }] },
  ] },
  { id: 'Vendas', label: 'Vendas', groups: [
    { reports: [{ title: 'Notas Fiscais por Operação', description: 'Relação de notas fiscais emitidas agrupadas pela natureza da operação.' }, { title: 'Relatório de Vendas', description: 'Relatório que permite agrupamento por cliente, produto ou vendedor.' }, { title: 'Relatório de Vendas Agrupado por bairro', description: 'Relatório que permite agrupamento das vendas por bairro.' }, { title: 'Notas Fiscais por Cliente', description: 'Fornece o total de notas fiscais emitidas agrupadas pelo cliente.' }, { title: 'Notas Fiscais por Produto', description: 'Fornece o total de notas fiscais emitidas agrupadas por produto.' }, { title: 'Evolução do Faturamento', description: 'Relatório e gráfico que mostra a evolução do valor emitido de notas fiscais em um período.', chart: true }] },
    { title: 'Comissões', reports: [{ title: 'Relatório Complementar de Comissões', description: 'Relatório das comissões emitidas vinculadas aos seus respectivos títulos', to: '/financeiro-empresa?area=comissoes-relatorio' }] },
    { title: 'Pedidos de Venda', reports: [{ title: 'Relatório de curva ABC de itens de vendas (últimos 30 dias)', description: 'Visão de Curva ABC de itens de vendas' }] },
  ] },
  { id: 'Financeiro', label: 'Finanças', groups: [
    { title: 'Caixas e Bancos', reports: [{ title: 'Balancete', description: 'Relatório e gráfico com as entradas e saídas do período.', chart: true }, { title: 'DRE', description: 'Relatório do demostrativo do resultado do exercício do período.' }, { title: 'Fluxo de Caixa', description: 'Relatório e gráfico da projeção das entradas e saídas futuras de acordo com as contas a pagar e receber.', chart: true }, { title: 'Resumo de Entradas e Saídas por Categoria', description: 'Relatório e gráfico das entradas e saídas agrupadas pela categoria de receita e despesa.', chart: true }, { title: 'Resumo de Entradas e Saídas por Cliente', description: 'Relatório das entradas e saídas agrupadas por cliente.' }] },
    { title: 'Contas a Pagar', reports: [{ title: 'Relatório de Pagamentos', description: 'Relação dos pagamentos do período.' }] },
    { title: 'Contas a Receber', reports: [{ title: 'Relatório de Recebimentos', description: 'Relação dos recebimentos do período.' }] },
    { title: 'Controle de Caixa', reports: [{ title: 'Relatório de Controle de Caixa', description: 'Relatório detalhado de Controle de Caixa' }] },
  ] },
  { id: 'Serviços', label: 'Serviços', groups: [{ title: 'Customizáveis', reports: [{ title: 'Relatório de Ocorrências por Ordem de Serviço', description: 'Visão de Ocorrências' }, { title: 'Relatório de Ordem de Serviço', description: 'Visão de Ordem de Serviço' }] }] },
];

export default function ReportsCatalog({ areas = REPORT_AREAS, param = 'filter.area' }: { areas?: readonly ReportArea[]; param?: string }) {
  const [params, setParams] = useSearchParams();
  const area = areas.find(item => item.id === params.get(param)) ?? areas.find(item => item.id === 'Vendas') ?? areas[0]!;
  return <main className="reports-catalog" id="main-content">
    <div className="reports-main"><h1>Relatório de {area.label}</h1>
      <nav className="reports-areas" aria-label="Módulos">{areas.map(item => <button type="button" key={item.id} aria-current={item.id === area.id ? 'page' : undefined} onClick={() => setParams({ [param]: item.id })}>{item.label}</button>)}</nav>
      {area.groups.map((group, index) => <section key={group.title || index} className="reports-group">{group.title && <h2>{group.title}</h2>}<ul>{group.reports.map(report => <li key={report.title}>{report.to ? <Link to={report.to} className="reports-item"><span className={`reports-icon${report.chart ? ' is-chart' : ''}`}><Icon name={report.chart ? 'chart-pie' : 'file-lines'} size={16} /></span><span><strong>{report.title}</strong><small>{report.description}</small></span></Link> : <div className="reports-item is-disabled" title="Relatório ainda não disponível no FAGOO"><span className={`reports-icon${report.chart ? ' is-chart' : ''}`}><Icon name={report.chart ? 'chart-pie' : 'file-lines'} size={16} /></span><span><strong>{report.title}</strong><small>{report.description}</small></span></div>}</li>)}</ul></section>)}
    </div>
    <aside className="reports-tips"><h2>Dicas</h2><div className="reports-tip"><Icon name="table-list" size={28} /><h3>Relatórios Customizados</h3><p>A criação de relatórios customizados, com escolha de campos, filtros e agrupamentos, será disponibilizada em uma próxima etapa.</p></div></aside>
  </main>;
}
