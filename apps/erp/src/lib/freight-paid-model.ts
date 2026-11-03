// Leva H (SQL 374: PRF-268): frete pago pela empresa of a pedido de venda, apart from the frete cobrado do cliente, and the costs
// applied on the operation at its commercial confirmation. Read and saved through /v1/documentos/sales_orders/{id}/frete-pago.
export interface FreightPaid {
  document_id: string; freight_charged: string; freight_paid: string | null; note: string | null; version: number;
  applied_costs: { item_id: string; product_id: string; unit_cost: string; basis: 'custo_medio' | 'preco_custo' | 'ultimo_pedido_compra'; applied_on: string }[];
}
export const freightPaidPath = (documentId: string) => `/v1/documentos/sales_orders/${documentId}/frete-pago`;
export function readFreightPaid(value: unknown, documentId: string): FreightPaid {
  const item = (value as { entity?: unknown; item?: FreightPaid } | null)?.item;
  if ((value as { entity?: unknown } | null)?.entity !== 'freight_paid' || !item || item.document_id !== documentId || !Number.isInteger(item.version) || !Array.isArray(item.applied_costs)
    || (item.freight_paid !== null && !/^\d{1,12}\.\d{2}$/.test(item.freight_paid))) throw new Error('Resposta inválida do frete pago.');
  return item;
}
