/** Labels of the Origin invoice form and item tax tabs (capture of 19/10/2026). Codes are the NF-e 4.00 layout values. */
export const ICMS_CST = Object.freeze([
  ['00', '00 Tributada integralmente'], ['02', '02 Monofásica própria sobre combustíveis'], ['10', '10 Tributada e com cobrança do ICMS por ST'],
  ['15', '15 Monofásica própria e com responsabilidade pela retenção'], ['20', '20 Com redução de base de cálculo'], ['30', '30 Isenta ou não tributada e com cobrança por ST'],
  ['40', '40 Isenta'], ['41', '41 Não tributada'], ['50', '50 Suspensão'], ['51', '51 Diferimento'], ['53', '53 Monofásica com recolhimento diferido'],
  ['60', '60 ICMS cobrado anteriormente por ST'], ['61', '61 Monofásica cobrada anteriormente'], ['70', '70 Redução de BC e cobrança por ST'], ['90', '90 Outras'],
]);
export const ICMS_CSOSN = Object.freeze([
  ['101', '101 Tributada pelo Simples Nacional com permissão de crédito'], ['102', '102 Tributada pelo Simples Nacional sem permissão de crédito'],
  ['103', '103 Isenção do ICMS no Simples Nacional para faixa de receita bruta'], ['201', '201 Tributada pelo Simples Nacional com permissão de crédito e com cobrança do ICMS por ST'],
  ['202', '202 Tributada pelo Simples Nacional sem permissão de crédito e com cobrança do ICMS por ST'], ['203', '203 Isenção do ICMS no Simples Nacional para faixa de receita bruta e com cobrança do ICMS por ST'],
  ['300', '300 Imune'], ['400', '400 Não tributada pelo Simples Nacional'], ['500', '500 ICMS cobrado anteriormente por ST ou por antecipação'], ['900', '900 Outros'],
  ['02', '02 Monofásica própria sobre combustíveis'], ['15', '15 Monofásica própria e com responsabilidade pela retenção'], ['53', '53 Monofásica com recolhimento diferido'], ['61', '61 Monofásica cobrada anteriormente'],
]);
export const TAXATION = Object.freeze([['T', 'Tributado'], ['I', 'Isento'], ['O', 'Outra situação']]);
export const ORIGIN = Object.freeze([['0', '0 Nacional'], ['1', '1 Estrangeira importação direta'], ['2', '2 Estrangeira mercado interno'], ['3', '3 Nacional CI 40-70%'],
  ['4', '4 Nacional processos produtivos básicos'], ['5', '5 Nacional CI até 40%'], ['6', '6 Estrangeira direta sem similar (CAMEX)'], ['7', '7 Estrangeira mercado interno sem similar (CAMEX)'], ['8', '8 Nacional CI > 70%']]);
export const BC_MODE = Object.freeze([['0', 'Margem Valor Agregado (%)'], ['1', 'Pauta (valor)'], ['2', 'Preço Tabelado Máx. (valor)'], ['3', 'Valor da operação']]);
export const ST_BC_MODE = Object.freeze([['0', 'Preço tabelado ou máximo sugerido'], ['1', 'Lista Negativa (valor)'], ['2', 'Lista Positiva (valor)'], ['3', 'Lista Neutra (valor)'],
  ['4', 'Margem Valor Agregado (%)'], ['5', 'Pauta (valor)'], ['6', 'Valor da Operação']]);
export const DESON_REASON = Object.freeze([['1', '1 Taxi'], ['3', '3 Produtor Agropecuário'], ['4', '4 Frotista/Locadora'], ['5', '5 Diplomático/Consular'],
  ['6', '6 Utilitários e Motocicletas da Amazônia Ocidental e ALC'], ['7', '7 SUFRAMA'], ['8', '8 Venda a Órgão Público'], ['9', '9 Outros'], ['10', '10 Deficiente Condutor'],
  ['11', '11 Deficiente Não Condutor'], ['90', '90 Solicitado pelo Fisco']]);
export const ST_DESON_REASON = Object.freeze([['3', '3 Uso na agropecuária'], ['9', '9 Outros'], ['90', '90 Órgão de fomento']]);
export const REDUCTION_REASON = Object.freeze([['1', '1 Transporte coletivo de passageiros'], ['9', '9 Outros']]);
export const DIFAL_TYPE = Object.freeze([['N', 'Normal'], ['I', 'Isento']]);
export const INTERSTATE_RATE = Object.freeze([['4.0000', '4%'], ['7.0000', '7%'], ['12.0000', '12%']]);
export const IPI_CST = Object.freeze([['00', '00 Entrada com recuperação de crédito'], ['01', '01 Entrada tributada com alíquota zero'], ['02', '02 Entrada isenta'], ['03', '03 Entrada não-tributada'],
  ['04', '04 Entrada imune'], ['05', '05 Entrada com suspensão'], ['49', '49 Outras entradas'], ['50', '50 Saída tributada'], ['51', '51 Saída tributada com alíquota zero'],
  ['52', '52 Saída isenta'], ['53', '53 Saída não-tributada'], ['54', '54 Saída imune'], ['55', '55 Saída com suspensão'], ['99', '99 Outras saídas']]);
export const PIS_CST = Object.freeze([['01', '01 Operação tributável (base = valor da operação, alíquota normal)'], ['02', '02 Operação tributável (base = valor da operação, alíquota diferenciada)'],
  ['03', '03 Operação tributável (base = quantidade × alíquota por unidade)'], ['04', '04 Operação tributável monofásica (revenda a alíquota zero)'], ['05', '05 Operação tributável por substituição tributária'],
  ['06', '06 Operação tributável a alíquota zero'], ['07', '07 Operação isenta da contribuição'], ['08', '08 Operação sem incidência da contribuição'], ['09', '09 Operação com suspensão da contribuição'],
  ['49', '49 Outras Operações de Saída'], ['50', '50 Com direito a crédito, vinculada a receita tributada no mercado interno'], ['51', '51 Com direito a crédito, vinculada a receita não tributada no mercado interno'],
  ['52', '52 Com direito a crédito, vinculada a receita de exportação'], ['53', '53 Com direito a crédito, vinculada a receitas tributadas e não tributadas no mercado interno'],
  ['54', '54 Com direito a crédito, vinculada a receitas tributadas no mercado interno e de exportação'], ['55', '55 Com direito a crédito, vinculada a receitas não tributadas no mercado interno e de exportação'],
  ['56', '56 Com direito a crédito, vinculada a receitas tributadas e não tributadas no mercado interno e de exportação'], ['60', '60 Crédito presumido, aquisição vinculada a receita tributada no mercado interno'],
  ['61', '61 Crédito presumido, aquisição vinculada a receita não tributada no mercado interno'], ['62', '62 Crédito presumido, aquisição vinculada a receita de exportação'],
  ['63', '63 Crédito presumido, aquisição vinculada a receitas tributadas e não tributadas no mercado interno'], ['64', '64 Crédito presumido, aquisição vinculada a receitas tributadas no mercado interno e de exportação'],
  ['65', '65 Crédito presumido, aquisição vinculada a receitas não tributadas no mercado interno e de exportação'], ['66', '66 Crédito presumido, aquisição vinculada a receitas tributadas e não tributadas no mercado interno e de exportação'],
  ['67', '67 Crédito presumido, outras operações'], ['70', '70 Aquisição sem direito a crédito'], ['71', '71 Aquisição com isenção'], ['72', '72 Aquisição com suspensão'],
  ['73', '73 Aquisição a alíquota zero'], ['74', '74 Aquisição sem incidência da contribuição'], ['75', '75 Aquisição por substituição tributária'], ['98', '98 Outras Operações de Entrada'], ['99', '99 Outras Operações']]);
export const SPED_TYPE = Object.freeze([['00', '00 Mercadoria para Revenda'], ['01', '01 Matéria-Prima'], ['02', '02 Embalagem'], ['03', '03 Produto em Processo'], ['04', '04 Produto Acabado'],
  ['05', '05 Subproduto'], ['06', '06 Produto Intermediário'], ['07', '07 Material de Uso e Consumo'], ['08', '08 Ativo Imobilizado'], ['09', '09 Serviços'], ['10', '10 Outros insumos'], ['99', '99 Outras']]);
export const SCALE = Object.freeze([['S', 'S - Produzido em Escala Relevante'], ['N', 'N - Produzido em Escala NÃO Relevante']]);
export const YES_NO = Object.freeze([['true', 'Sim'], ['false', 'Não']]);
export const CRT = Object.freeze([['1', 'Simples nacional'], ['2', 'Simples nacional - Excesso de sublimite de receita bruta'], ['3', 'Regime normal'], ['4', 'MEI']]);
export const PURPOSE = Object.freeze([['1', 'NF-e normal'], ['2', 'NF-e complementar'], ['3', 'NF-e de ajuste'], ['4', 'Devolução de mercadoria'], ['5', 'Nota de crédito'], ['6', 'Nota de débito']]);
export const PRESENCE = Object.freeze([['0', '0 - Não se aplica'], ['1', '1 - Operação presencial'], ['2', '2 - Operação não presencial, pela Internet'], ['3', '3 - Operação não presencial, Teleatendimento'],
  ['4', '4 - Operações não presenciais com NFC-e e NF-e com DANFE Simplificado Tipo 2 (com entrega)'], ['5', '5 - Operação presencial, fora do estabelecimento'], ['9', '9 - Operação não presencial, outros']]);
export const PERSON_TYPE = Object.freeze([['J', 'Jurídica'], ['F', 'Física'], ['E', 'Estrangeiro']]);
export const IE_INDICATOR = Object.freeze([['1', '1 - Contribuinte ICMS'], ['2', '2 - Contribuinte isento de Inscrição'], ['9', '9 - Não Contribuinte']]);
export const REFERENCE_TYPE = Object.freeze([['nfe', 'NF-e ou NFC-e (modelos 55 e 65)'], ['ecf', 'Cupom fiscal (ECF - modelo 2D)'], ['nf01', 'Nota fiscal (talão - modelo 01)'],
  ['nf02', 'Nota fiscal de consumidor (talão - modelo 02)'], ['nfp01', 'Nota fiscal de produtor (talão - modelo 01)'], ['nfp04', 'Nota fiscal de produtor (talão - modelo 04)'], ['cte', 'CT-e (modelo 57)']]);
export const TRANSPORT_MODE = Object.freeze([['none', 'Não haverá transporte'], ['manual', 'Inserir transportadora manualmente']]);
export const FREIGHT_BY = Object.freeze([['0', '0 - Contratação do Frete por conta do Remetente (CIF)'], ['1', '1 - Contratação do Frete por conta do Destinatário (FOB)'],
  ['2', '2 - Contratação do Frete por conta de Terceiros'], ['3', '3 - Transporte Próprio por conta do Remetente'], ['4', '4 - Transporte Próprio por conta do Destinatário'], ['9', '9 - Sem Ocorrência de Transporte']]);
export const SPECIES = Object.freeze([['outros', 'Outro(s)'], ['volumes', 'Volume(s)'], ['unidades', 'Unidade(s)'], ['caixas', 'Caixa(s)'], ['pacotes', 'Pacote(s)'], ['envelopes', 'Envelope(s)'], ['pallets', 'Pallet(s)'], ['sacos', 'Saco(s)']]);
export const PAYMENT_METHOD = Object.freeze([['01', 'Dinheiro'], ['02', 'Cheque'], ['03', 'Cartão de Crédito'], ['04', 'Cartão de Débito'], ['05', 'Crédito Loja'], ['10', 'Vale Alimentação'],
  ['11', 'Vale Refeição'], ['12', 'Vale Presente'], ['13', 'Vale Combustível'], ['15', 'Boleto Bancário'], ['16', 'Depósito Bancário'], ['17', 'Pagamento Instantâneo (PIX)'],
  ['18', 'Transferência bancária, Carteira Digital'], ['19', 'Programa de fidelidade, Cashback, Crédito Virtual'], ['20', 'Pagamento Instantâneo (PIX) estático'], ['90', 'Sem pagamento'], ['99', 'Outros']]);
export const CARD_INTEGRATION = Object.freeze([['1', 'Pagamento integrado com o sistema de automação da empresa'], ['2', 'Pagamento não integrado com o sistema de automação da empresa']]);
// Bandeira da operadora de cartão (tBand, NT 2020.006); the card group of the parcel keeps the two-digit code.
export const CARD_BRAND = Object.freeze([['01', 'Visa'], ['02', 'Mastercard'], ['03', 'American Express'], ['04', 'Sorocred'], ['05', 'Diners Club'], ['06', 'Elo'], ['07', 'Hipercard'], ['08', 'Aura'],
  ['09', 'Cabal'], ['10', 'Alelo'], ['11', 'Banes Card'], ['12', 'CalCard'], ['13', 'Credz'], ['14', 'Discover'], ['15', 'GoodCard'], ['16', 'GreenCard'], ['17', 'Hiper'], ['18', 'JCB'], ['19', 'Mais'],
  ['20', 'MaxVan'], ['21', 'Policard'], ['22', 'RedeCompras'], ['23', 'Sodexo'], ['24', 'ValeCard'], ['25', 'Verocheque'], ['26', 'VR'], ['27', 'Ticket'], ['99', 'Outros']]);
export const IMPORT_ROUTE = Object.freeze([['1', '1 Marítima'], ['2', '2 Fluvial'], ['3', '3 Lacustre'], ['4', '4 Aérea'], ['5', '5 Postal'], ['6', '6 Ferroviária'], ['7', '7 Rodoviária'],
  ['8', '8 Conduto / Rede Transmissão'], ['9', '9 Meios Próprios'], ['10', '10 Entrada / Saída ficta'], ['11', '11 Courier'], ['12', '12 Em mãos'], ['13', '13 Por reboque']]);
export const IMPORT_FORM = Object.freeze([['1', '1 Por conta própria'], ['2', '2 Por conta e ordem'], ['3', '3 Por encomenda']]);
export const II_SITUATION = Object.freeze([['T', 'Tributado'], ['N', 'Não tributado']]);
export const DISCOUNT_TYPE = Object.freeze([['C', 'Condicional'], ['I', 'Incondicional']]);
export const APPROX_TAX_TYPE = Object.freeze([['table', 'Alíquota Tabela'], ['fixed', 'Alíquota fixa'], ['product', 'Alíquota no produto']]);
export const DIFAL_MODE = Object.freeze([['inside', 'Com ICMS por dentro'], ['goods', 'Somente valor da mercadoria'], ['none', 'Não calcular'], ['validated', 'Calcular apenas campos validados (Alíq. Interestadual e % partilha)']]);
export const DIFAL_STATE_MODE = Object.freeze([['default', 'Utilizar padrão do sistema'], ['inside', 'Com ICMS por dentro'], ['goods', 'Somente valor da mercadoria'], ['none', 'Não calcular'],
  ['validated', 'Calcular apenas campos validados'], ['double_base', 'Base dupla com exclusão do ICMS'], ['single_base', 'Base única com exclusão do ICMS']]);
export const DEFAULT_LABELS = Object.freeze({ S: 'Padrão venda', E: 'Padrão compra', VF: 'Padrão venda física', VJ: 'Padrão venda jurídica', CF: 'Padrão compra física',
  CJ: 'Padrão compra jurídica', C: 'Padrão venda cupom', DE: 'Padrão devolução (entrada)', DS: 'Padrão devolução (saída)' });
// Origin "Variáveis das informações complementares" (captured list). Brufap fills the ones it can compute; the others become empty.
export const INFO_VARIABLES = Object.freeze({
  impostos: ['VALOR_BASE_ICMS', 'VALOR_ICMS', 'VALOR_BASE_DIFERIMENTO', 'VALOR_DIFERIMENTO', 'ICMS_PRESUMIDO', 'VALOR_CREDITO_ICMS', 'ALIQUOTA_CREDITO_ICMS', 'VALOR_ICMS_ST', 'VALOR_ICMS_RETIDO',
    'ALIQUOTA_ICMS_RETIDO', 'VALOR_BASE_ICMS_RETENCAO', 'VALOR_IPI_DEVOLVIDO', 'APROX_TRIB', 'VALOR_PIS', 'VALOR_COFINS', 'VALOR_FCP', 'VALOR_RET_IR', 'VALOR_RET_CSLL', 'VALOR_RET_PIS',
    'VALOR_RET_COFINS', 'VALOR_RET_ISS', 'ALIQUOTA_DIFAL', 'VALOR_ICMS_DESONERADO'],
  outras: ['PESO_LIQUIDO', 'PESO_BRUTO', 'NUMERO_CUPOM', 'NUMERO_PEDIDO', 'NOME_FANTASIA', 'PEDIDO_COMPRA', 'NOME_VENDEDOR', 'NUMERO_DI', 'DATA_REGISTRO_DI', 'LOCAL_DESEMBARACO',
    'NOME_CANAL_VENDA', 'NOME_LOJA', 'DOC_REFERENCIADO_DATA', 'DOC_REFERENCIADO_NUMERO', 'DOC_REFERENCIADO_CHAVE'],
});
// Armamento (grupo arma) and Veículo (grupo veicProd) of the NF-e 4.00 item.
export const WEAPON_TYPE = Object.freeze([['0', 'Uso permitido'], ['1', 'Uso restrito']]);
export const VEHICLE_OPERATION = Object.freeze([['1', '1 Venda concessionária'], ['2', '2 Faturamento direto para consumidor final'], ['3', '3 Venda direta para grandes consumidores'], ['0', '0 Outros']]);
export const VEHICLE_SPECIES = Object.freeze([['1', '1 Passageiro'], ['2', '2 Carga'], ['3', '3 Misto'], ['4', '4 Corrida'], ['5', '5 Tração'], ['6', '6 Especial']]);
export const VIN_CONDITION = Object.freeze([['N', 'Normal'], ['R', 'Remarcado']]);
export const VEHICLE_CONDITION = Object.freeze([['1', '1 Acabado'], ['2', '2 Inacabado'], ['3', '3 Semiacabado']]);
export const VEHICLE_RESTRICTION = Object.freeze([['0', '0 Não há'], ['1', '1 Alienação Fiduciária'], ['2', '2 Arrendamento Mercantil'], ['3', '3 Reserva de Domínio'], ['4', '4 Penhor de Veículos'], ['9', '9 Outras']]);
export const labelOf = (table, code) => (table.find(([value]) => value === code) ?? [code, code])[1];
