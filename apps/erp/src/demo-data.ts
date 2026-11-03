import type { DemoRecord } from './types';

/** Entirely synthetic fixtures. Never load Origin CSVs or staging into this file. */
export const DEMO_REFERENCE_DATE = '2026-10-16';
const day = (value: number) => `2026-10-${String(value).padStart(2, '0')}`;
const code = (value: number) => String(value + 1).padStart(3, '0');
const round = (value: number) => Math.round(value * 100) / 100;
const pick = <T,>(values: T[], index: number): T => values[index % values.length];
const customer = (index: number) => `Cliente Modelo ${String(index % 12 + 1).padStart(2, '0')} (demo)`;
const supplier = (index: number) => `Fornecedor Modelo ${String(index % 3 + 1).padStart(2, '0')} (demo)`;
const sellers = ['Equipe Alfa (demo)', 'Equipe Beta (demo)', 'Equipe Gama (demo)'];
const banks = ['Itaú — demonstração', 'Inter — demonstração', 'Caixa — demonstração'];
const payments = ['Boleto', 'Pix recebido externamente', 'Dinheiro', 'Transferência', 'Cartão'];
const warehouses = ['Geral (demo)', 'Reserva (demo)', 'Assistência (demo)'];
const products = ['Rolamento de apoio', 'Correia de transmissão', 'Conjunto de vedação', 'Parafuso sextavado', 'Porca de fixação', 'Arruela lisa', 'Bucha de adaptação', 'Chave combinada', 'Mangueira flexível', 'Conector rápido', 'Disco de corte', 'Abraçadeira metálica', 'Suporte de montagem', 'Kit de manutenção', 'Lubrificante sintético', 'Serviço de revisão'];
const saleStates = ['Em aberto', 'Em digitação', 'Em andamento', 'Atendido', 'Cancelado', 'Verificado', 'Atendido parcialmente'];
const proposalStates = ['Em aberto', 'Rascunho', 'Pendente', 'Aguardando', 'Aprovado', 'Não aprovado', 'Concluído', 'Modelos'];
const fiscalStates = ['Pendente', 'Autorizada', 'Cancelada', 'Rejeitada', 'Aguardando protocolo'];
const serviceStates = ['Em aberto', 'Orçada', 'Aprovada', 'Não aprovada', 'Em andamento', 'Aguardando componentes', 'Serviço concluído', 'Finalizada', 'Finalizada sem conserto'];

function rows(moduleId: string, make: (index: number) => Omit<DemoRecord, 'id'>, count = 16): DemoRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `DEMO-${moduleId}-${code(index)}`,
    demo: true,
    origin: 'Demonstração local — sem vínculo com a operação real',
    notes: 'Registro fictício para explorar a interface. Não usar em documentos fiscais, cobranças ou conferência de saldos reais.',
    ...make(index),
  }));
}

function commercial(index: number, prefix: string, states: string[], isPurchase = false): Omit<DemoRecord, 'id'> {
  const quantity = index % 5 + 1;
  const unitPrice = round(38.5 + index * 12.75);
  const discount = index % 4 === 0 ? 5 : 0;
  const freight = index % 3 === 0 ? 18 : 0;
  return {
    number: `${prefix}-${String(1001 + index)}`, customer: isPurchase ? supplier(index) : customer(index),
    date: day(index % 15 + 1), status: pick(states, index), seller: pick(sellers, index),
    product: pick(products, index), sku: `DEMO-${code(index % products.length)}`,
    quantity, unit: index % 16 === 15 ? 'H' : 'UN', unitPrice, discount, freight, otherExpenses: 0,
    _items: JSON.stringify([{ id: `ITEM-DEMO-${prefix}-${code(index)}`, description: pick(products, index), sku: `DEMO-${code(index % products.length)}`, quantity, unit: index % 16 === 15 ? 'H' : 'UN', listPrice: unitPrice, unitPrice, discount: 0 }]),
    total: round(quantity * unitPrice - discount + freight),
    paymentMethod: pick(payments, index), paymentTerms: pick(['À vista', '15 dias', '30 dias', '30 / 60 dias'], index),
    deliveryDate: day(index % 10 + 18), deliveryAddress: `Endereço fictício ${code(index)}, Piracicaba / SP`,
    lot: `L-DEMO-00${index % 3 + 1}`, postalCode: 'Não informado (demo)',
    trackingStatus: index % 2 ? 'Com rastreamento' : 'Sem rastreamento', trackingCode: index % 2 ? `DEMO-R00${index % 3 + 1}` : '',
    component: pick(['Rolamento de apoio', 'Conjunto de vedação', 'Parafuso sextavado'], index),
    carrier: `Transportadora Modelo 0${index % 2 + 1} (demo)`, purchaseOrder: `OC-DEMO-00${index % 3 + 1}`, state: pick(['SP', 'MG', 'PR'], index),
    city: pick(['Piracicaba / SP', 'Limeira / SP', 'Rio Claro / SP'], index), customerEmail: `cliente${code(index % 12)}@example.invalid`,
    internalNotes: 'Anotação interna de demonstração; sem envio ao cliente.',
  };
}

function title(index: number, payable = false): Omit<DemoRecord, 'id'> {
  const states = payable ? ['Em aberto', 'Parcialmente pago', 'Pago', 'Cancelado'] : ['Em aberto', 'Parcialmente recebido', 'Recebido', 'Cancelado'];
  const state = payable && index === 17 ? 'Em processamento' : pick(states, index);
  const total = round(175 + index * 86.75);
  const settled = index % 4 >= 2;
  const dueDay = [8, 16, 20, 24, 12, 16, 26, 29][index % 8];
  const balance = settled ? 0 : index % 4 === 1 ? round(total * 0.6) : total;
  const account = pick(banks, index);
  const bankAccount = account.startsWith('Itaú') ? 'ITAU' : account.startsWith('Inter') ? 'INTER' : 'CAIXA';
  return {
    number: `${payable ? 'CP' : 'CR'}-DEMO-${String(2001 + index)}`,
    identification: `IDENT-DEMO-${code(index)}`,
    customer: payable ? supplier(index) : customer(index),
    description: `${payable ? 'Compra de materiais' : 'Venda de componentes'} — parcela ${index % 3 + 1}/3 (demo)`,
    date: day(index % 10 + 1), competenceDate: day(1), dueDate: day(dueDay),
    paymentDate: state === (payable ? 'Pago' : 'Recebido') ? day(Math.min(dueDay + 1, 15)) : '',
    total, balance, installment: `${index % 3 + 1}/3`, status: state,
    dueStatus: dueDay < 16 ? 'Atrasado' : dueDay === 16 ? 'Vence hoje' : 'Em dia',
    option: state === 'Em processamento' ? 'Em processamento' : state === (payable ? 'Pago' : 'Recebido') ? (payable ? 'Pagas' : 'Recebidas') : balance > 0 && dueDay < 16 ? 'Atrasadas' : index % 3 === 0 ? 'Emitidas' : 'Em aberto',
    category: payable ? pick(['Compra de mercadorias', 'Despesas operacionais', 'Manutenção'], index) : pick(['Venda de produtos', 'Serviços', 'Outras receitas'], index),
    account, paymentMethod: pick(payments, index), paymentType: pick(['Boleto bancário', 'Pix', 'Dinheiro', 'Transferência bancária', 'Cartão de crédito'], index),
    bankReference: index % 5 === 0 ? '' : `DEMO-${bankAccount}-${code(index)}`,
    remittanceStatus: index % 3 === 0 ? 'Incluídas em remessa' : 'Não incluídas',
    valueRange: total < 500 ? 'Até R$ 500' : total <= 1000 ? 'De R$ 500 a R$ 1.000' : 'Acima de R$ 1.000',
    seller: pick(sellers, index),
  };
}

const categories = ['Venda de produtos', 'Serviços', 'Outras receitas', 'Compra de mercadorias', 'Fretes de compra', 'Despesas operacionais', 'Manutenção', 'Embalagens', 'Tarifas bancárias', 'Comissões', 'Transferências internas', 'Despesas administrativas'];

export const DEMO_DATA: Record<string, DemoRecord[]> = {
  produtos: rows('produtos', (i) => {
    const stock = [24, 0, 8, 145, -2, 62, 0, 11, 37, -1, 86, 0, 18, 5, 42, 0][i];
    const productType = i === 15 ? 'Serviços' : pick(['Simples', 'Variações', 'Produtos sem composição', 'Produtos com composição'], i);
    return {
      description: products[i], sku: `DEMO-${code(i)}`, unit: i === 15 ? 'H' : i === 14 ? 'CX' : 'UN',
      price: round(38.5 + i * 12.75), cost: round(21 + i * 8.5), stock,
      status: i === 13 ? 'Excluídos' : i % 5 === 0 ? 'Inativos' : 'Ativos',
      stockFilter: stock === 0 ? 'Igual a zero' : stock < 0 ? 'Menor que zero' : 'Maior que zero',
      hasImages: i % 3 === 0 ? 'Sim' : 'Não', lotControl: i % 4 === 0 ? 'Sim' : 'Não',
      tag: pick(['Reposição', 'Linha padrão', 'Sob encomenda'], i),
      category: i === 15 ? 'Serviços' : pick(['Componentes', 'Ferramentas', 'Consumíveis'], i),
      ncm: i % 4 === 0 ? '' : 'DEMO — classificação não fiscal', ncmFilter: i % 4 === 0 ? 'Sem NCM' : 'Com NCM',
      classification: i === 15 ? 'Serviços' : pick(['Mercadoria para revenda', 'Matéria-prima', 'Embalagem', 'Produto em processo', 'Produto acabado', 'Subproduto', 'Produto intermediário', 'Material de uso e consumo', 'Ativo imobilizado', 'Outros'], i),
      productType, brand: pick(['Linha Aurora', 'Linha Horizonte', 'Sem marca'], i),
      supplier: supplier(i), supplierCode: `DEMO-F0${i % 3 + 1}`, minimumStock: 5 + i % 4,
      location: `Prateleira ${String.fromCharCode(65 + i % 4)}-${i % 6 + 1}`, date: day(i % 15 + 1),
    };
  }),
  contatos: rows('contatos', (i) => ({
    name: i % 4 === 1 ? supplier(i) : customer(i), tradeName: `Estabelecimento Modelo ${code(i)} (demo)`,
    code: `CONT-DEMO-${code(i)}`, role: pick(['Cliente', 'Fornecedor', 'Cliente e fornecedor', 'Transportadora'], i),
    personType: pick(['Pessoa jurídica', 'Pessoa física', 'Estrangeiro'], i), document: '',
    city: pick(['Piracicaba / SP', 'Limeira / SP', 'Rio Claro / SP', 'Americana / SP'], i),
    phone: 'Não informado (demo)', phoneFilter: 'Não informado', email: i % 5 === 0 ? '' : `contato${code(i)}@example.invalid`, emailFilter: i % 5 === 0 ? 'Sem e-mail' : 'Com e-mail',
    address: `Endereço fictício ${code(i)}`, seller: pick(sellers, i),
    paymentTerms: pick(['À vista', '15 dias', '30 dias'], i), status: i === 13 ? 'Excluídos' : i % 5 === 0 ? 'Inativos' : 'Ativos',
    state: 'SP', priceList: pick(['Padrão (demo)', 'Atacado (demo)', 'Manutenção (demo)'], i), noMovement: i % 4 === 0, date: day(i % 15 + 1),
  })),
  vendedores: rows('vendedores', (i) => ({ name: `Vendedor Modelo ${code(i)} (demo)`, code: `VEND-DEMO-${code(i)}`, email: `vendedor${code(i)}@example.invalid`, commissionRate: pick([2, 3, 4, 5], i), status: i % 5 === 0 ? 'Inativo' : 'Ativo' }), 12),
  'contas-financeiras': rows('contas-financeiras', (i) => ({
    description: `${pick(['Itaú', 'Inter', 'Caixa'], i)} ${code(i)} — demonstração`,
    bank: pick(['Itaú', 'Inter', 'Caixa'], i), kind: i % 3 === 2 ? 'Caixa' : 'Conta corrente',
    agency: 'DEMO', accountNumber: `DEMO-${code(i)}`, agreement: '', wallet: 'A confirmar',
    cnab: i % 3 === 2 ? 'Não aplicável' : 'CNAB 400 — não habilitado', status: i >= 9 ? 'Inativo' : 'Ativo',
  }), 12),
  'categorias-financeiras': rows('categorias-financeiras', (i) => ({ description: categories[i], kind: i <= 2 ? 'Receita' : i === 10 ? 'Transferência' : 'Despesa', parent: i <= 2 ? 'Receitas' : i === 10 ? 'Movimentações internas' : 'Despesas', dreGroup: i === 10 ? 'Não compõe resultado' : i <= 2 ? 'Receita operacional' : 'Despesas operacionais', status: i === 11 ? 'Inativo' : 'Ativo' }), 12),
  'formas-pagamento': rows('formas-pagamento', (i) => ({ description: `${pick(payments, i)} ${pick(['à vista', '15 dias', '30 dias'], i)} (demo)`, kind: pick(payments, i), account: pick(banks, i), paymentTerms: pick(['À vista', '15 dias', '30 dias'], i), status: i >= 10 ? 'Inativo' : 'Ativo' }), 12),
  'categorias-produtos': rows('categorias-produtos', (i) => ({ description: pick(['Rolamentos', 'Correias', 'Vedações', 'Fixadores', 'Buchas', 'Ferramentas manuais', 'Mangueiras', 'Conectores', 'Abrasivos', 'Suportes', 'Lubrificantes', 'Serviços'], i), parent: i < 5 ? 'Componentes' : i < 10 ? 'Ferramentas' : i === 10 ? 'Consumíveis' : 'Serviços', productCount: 4 + i * 3, status: i === 10 ? 'Inativo' : 'Ativo' }), 12),
  'listas-precos': rows('listas-precos', (i) => ({ description: `${pick(['Padrão', 'Atacado', 'Manutenção', 'Sob encomenda'], i)} ${code(i)} (demo)`, validUntil: day(i % 10 + 20), adjustment: pick([0, -5, -10, 3], i), productCount: 8 + i * 2, status: i % 4 === 3 ? 'Inativo' : 'Ativo' }), 12),
  vendas: rows('vendas', (i) => commercial(i, 'PV-DEMO', saleStates), 18),
  'notas-saida': rows('notas-saida', (i) => ({ ...commercial(i, 'NF-DEMO', fiscalStates), series: String(i % 2 + 1), model: '55', environment: 'Demonstração', fiscalKey: '', protocol: '', notes: 'Documento fictício, sem chave, assinatura, protocolo ou autorização da SEFAZ.' })),
  nfce: rows('nfce', (i) => ({ ...commercial(i, 'NFC-DEMO', fiscalStates), customer: i % 3 === 0 ? 'Consumidor não identificado (demo)' : customer(i), series: String(i % 2 + 1), model: '65', environment: 'Demonstração', fiscalKey: '', protocol: '', status: i % 5 === 4 ? 'Em contingência' : pick(fiscalStates, i), fiscalFilter: i % 5 === 4 ? 'Em contingência' : i % 5 === 1 ? 'Emitidas' : i % 5 === 2 ? 'Canceladas' : 'Pendentes', notes: 'NFC-e fictícia. Não existe XML autorizado, DANFE fiscal ou QR Code válido.' })),
  'frente-caixa': rows('frente-caixa', (i) => ({ ...commercial(i, 'CX-DEMO', ['Em atendimento', 'Aguardando pagamento', 'Finalizado', 'Cancelado']), customer: i % 2 ? customer(i) : 'Consumidor não identificado (demo)' }), 12),
  propostas: rows('propostas', (i) => ({ ...commercial(i, 'ORC-DEMO', proposalStates), version: String(i % 3 + 1), validUntil: day(i % 10 + 20), nextContact: day(i % 10 + 17), warranty: 'Conforme condições do orçamento demonstrativo', introduction: 'Orçamento fictício de fornecimento de componentes e manutenção.', convertedOrderId: '', careOf: 'Equipe de compras (demo)', priceList: 'Padrão (demo)', otherItems: '', paymentMode: pick(['Nenhum', 'Parcela', 'Texto'], i), deliveryDeadline: 'A confirmar na aprovação demonstrativa', freightResponsibility: pick(['Remetente', 'Destinatário', 'Terceiros', 'Sem transporte'], i), packageCount: i % 3 + 1, grossWeight: i % 5 + 2, signature: 'Equipe comercial de demonstração', department: 'Comercial', attachmentNotes: 'Nenhum arquivo anexado; campo demonstrativo.' }), 18),
  'ordens-servico': rows('ordens-servico', (i) => ({ ...commercial(i, 'OS-DEMO', serviceStates), equipment: pick(['Conjunto de acionamento', 'Bomba de demonstração', 'Unidade de montagem', 'Ferramenta de bancada'], i), technician: pick(['Técnico Alfa (demo)', 'Técnico Beta (demo)', 'Técnico Gama (demo)'], i), serialNumber: `SERIE-DEMO-${code(i)}`, accessories: 'Acessórios fictícios registrados na recepção', reportedIssue: pick(['Ruído durante o funcionamento', 'Vazamento aparente', 'Inspeção preventiva solicitada', 'Dificuldade de acionamento'], i), diagnosis: i % 3 ? 'Avaliação demonstrativa de desgaste dos componentes.' : 'Aguardando avaliação.', solution: i >= 6 ? 'Serviço demonstrativo registrado para teste do formulário.' : '', warranty: 'A definir após avaliação', service: pick(['Inspeção preventiva', 'Substituição de componentes', 'Revisão de bancada'], i) }), 18),
  compras: rows('compras', (i) => commercial(i, 'PC-DEMO', ['Em aberto', 'Em andamento', 'Atendido', 'Cancelado', 'Atendido parcialmente'], true)),
  'notas-entrada': rows('notas-entrada', (i) => ({ ...commercial(i, 'ENT-DEMO', ['Registrada', 'Cancelada', 'Pendente de conferência'], true), receiptStatus: pick(['Pendente', 'Parcial', 'Concluído'], i), entryKind: i % 2 ? 'Notas recebidas' : 'Notas de compra', linkage: i % 3 ? 'Pedido de compra demonstrativo' : 'Sem vinculação', model: '55', fiscalKey: '', notes: 'Documento de entrada fictício. Não corresponde a XML de fornecedor.' })),
  estoque: rows('estoque', (i) => ({ date: day(i % 15 + 1), product: pick(products.slice(0, 15), i), sku: `DEMO-${code(i % 15)}`, warehouse: pick(warehouses, i), movementType: pick(['Entrada', 'Saída', 'Balanço'], i), originType: pick(['Notas Fiscais', 'Vendas', 'Compras', 'Serviços', 'Transferências', 'Sem origem', 'Origem excluída'], i), barcode: `GTIN-DEMO-${code(i % 15)}`, quantity: pick([12, -3, 24, -5], i), balance: 18 + i * 3, origin: `Documento demonstrativo MOV-${code(i)}`, status: 'Demonstrativo' }), 18),
  'conferencia-estoque': rows('conferencia-estoque', (i) => ({ number: `CONF-DEMO-${code(i)}`, warehouse: pick(warehouses, i), date: day(i % 15 + 1), productCount: 8 + i * 2, difference: i % 4, status: pick(['Em aberto', 'Em contagem', 'Conferida'], i), responsible: pick(['Equipe Alfa (demo)', 'Equipe Beta (demo)'], i) }), 12),
  depositos: rows('depositos', (i) => ({ description: `${pick(['Geral', 'Reserva', 'Assistência'], i)} ${code(i)} (demo)`, location: `Área fictícia ${String.fromCharCode(65 + i)}`, responsible: pick(sellers, i), status: i >= 9 ? 'Inativo' : 'Ativo' }), 12),
  'caixas-bancos': rows('caixas-bancos', (i) => ({ date: day(i % 15 + 1), description: `${pick(['Recebimento de título', 'Pagamento de fornecedor', 'Transferência interna'], i)} ${code(i)} (demo)`, account: pick(banks, i), customer: i % 3 === 0 ? customer(i) : supplier(i), category: pick(categories, i), value: i % 3 === 0 ? round(350 + i * 48.5) : -round(125 + i * 22.75), incoming: i % 3 === 0 ? round(350 + i * 48.5) : 0, outgoing: i % 3 !== 0 ? round(125 + i * 22.75) : 0, balance: round(2480 + i * 71.25), movementType: pick(['Entrada', 'Saída', 'Transferência'], i), origin: `MOV-DEMO-${code(i)}` }), 18),
  'contas-pagar': rows('contas-pagar', (i) => title(i, true), 18),
  'contas-receber': rows('contas-receber', (i) => title(i), 18),
  'remessas-retornos': rows('remessas-retornos', (i) => ({ number: `CNAB-DEMO-${code(i)}`, name: `Arquivo de demonstração ${code(i)}`, bank: i % 2 ? 'Inter' : 'Itaú', fileType: i % 4 < 2 ? 'Remessa' : 'Retorno', date: day(i % 15 + 1), titleCount: i % 5 + 2, total: round(860 + i * 143.25), layout: 'CNAB 400 — exemplo sem arquivo', status: pick(['Em preparação', 'Gerada', 'Processado', 'Com rejeições'], i), notes: 'Registro demonstrativo. Nenhum CNAB foi criado, enviado ao banco ou processado.' }), 12),
  'ficha-financeira': rows('ficha-financeira', (i) => { const total = round(1800 + i * 230); const paid = round(total * 0.6); return { customer: i % 3 === 0 ? supplier(i) : customer(i), role: i % 3 === 0 ? 'Fornecedor' : 'Cliente', total, paid, balance: round(total - paid), overdue: i % 3 ? round(total * 0.1) : 0 }; }),
  comissoes: rows('comissoes', (i) => { const baseAmount = 450 + i * 125; const commissionRate = pick([2, 3, 4], i); return { seller: pick(sellers, i), number: `PV-DEMO-${1001 + i}`, date: day(i % 15 + 1), baseAmount, commissionRate, total: round(baseAmount * commissionRate / 100), status: pick(['A apurar', 'Apurada', 'Paga'], i) }; }),
  'controle-caixa': rows('controle-caixa', (i) => { const opening = 200; const incoming = round(580 + i * 85.5); const outgoing = round(90 + i * 12.25); return { number: `CX-DEMO-${code(i)}`, date: day(i % 15 + 1), responsible: pick(sellers, i), opening, incoming, outgoing, balance: round(opening + incoming - outgoing), status: pick(['Aberto', 'Fechado', 'Em conferência'], i) }; }),
  'faturamento-agrupado': rows('faturamento-agrupado', (i) => ({ number: `GRUPO-DEMO-${code(i)}`, customer: customer(i), date: day(i % 15 + 1), documentCount: i % 4 + 2, total: round(670 + i * 185.75), status: pick(['Pendente', 'Em conferência', 'Concluído'], i) }), 12),
  relatorios: rows('relatorios', (i) => ({ description: pick(['Vendas por período', 'Vendas por cliente', 'Vendas por produto', 'Saldo de estoque', 'Movimentações de estoque', 'Conferências de estoque', 'Contas a receber', 'Contas a pagar', 'Fluxo de caixa', 'Comissões por vendedor', 'Ordens de serviço', 'Serviços por situação'], i), area: i < 3 ? 'Vendas' : i < 6 ? 'Estoque' : i < 10 ? 'Financeiro' : 'Serviços', period: 'Outubro de 2026 — demonstração', updated: DEMO_REFERENCE_DATE, status: 'Demonstrativo' }), 12),
  configuracoes: rows('configuracoes', (i) => ({
    description: ['Empresa', 'Regime tributário', 'Perfis de acesso', 'Usuários', 'NF-e modelo 55', 'NFC-e modelo 65', 'Certificado digital', 'QR Code / CSC', 'Cobrança Itaú', 'Cobrança Inter', 'Depósito padrão', 'Numeração de documentos'][i],
    area: ['Empresa', 'Fiscal', 'Usuários', 'Usuários', 'Fiscal', 'Fiscal', 'Fiscal', 'Fiscal', 'Bancário', 'Bancário', 'Operação', 'Operação'][i],
    value: ['Empresa de demonstração', 'A confirmar', 'Perfis demonstrativos', 'Sem usuários de produção', 'Emissor em desenvolvimento', 'Emissor em desenvolvimento', 'Não configurado nesta demonstração', 'Não configurado nesta demonstração', 'CNAB 400 — a homologar', 'CNAB 400 — a homologar', 'Geral (demo)', 'Sequências fictícias'][i],
    status: i === 0 || i === 10 || i === 11 ? 'Demonstrativo' : 'Pendente',
  }), 12),
};

// Origin-style row indicators (letters P/C/E/V/N/O and icons), synthetic only. Codes are rendered by App.tsx.
const INDICATOR_SETS: Record<string, string[]> = {
  vendas: ['P,C,OBS,E', 'P,E', 'M,C,E', 'P,OBS,E', '', 'P,OBS,ALERT,E', 'P,E', 'C,E'],
  'notas-saida': ['C,V,E', 'C,M,V,E', 'V,E', 'ER,V', 'C,M,V,E'],
  nfce: ['V,E,C', 'V,E', 'V,C'],
  propostas: ['M', 'M', 'NE', 'M,OBS'],
  'ordens-servico': ['OBS', '', 'M', ''],
  compras: ['', 'E,C'],
  'notas-entrada': ['C,P,E', 'C,E', 'M,E', 'C,P,E'],
  'contas-pagar': ['', 'R', ''],
  'contas-receber': ['M', '', 'M'],
};
for (const [moduleId, sets] of Object.entries(INDICATOR_SETS)) DEMO_DATA[moduleId] = DEMO_DATA[moduleId]!.map((row, index) => ({ ...row, indicators: sets[index % sets.length] }));
