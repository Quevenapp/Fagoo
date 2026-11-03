// Preferências › Vendas › Vendas "Situação para aprovação de descontos" (202610200239): the configured approval situações.
export interface ApprovalSituation { id: string; name: string; color: string; active: boolean }
export interface DiscountApproval { version: number; can_write: boolean; situations: ApprovalSituation[]; replayed?: boolean }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The Worker already checks every field; this guards against a foreign or late answer. */
export function readDiscountApproval(value: unknown, save: boolean): DiscountApproval {
  const v = value as { kind?: unknown; version?: unknown; can_write?: unknown; situations?: unknown; replayed?: unknown } | null;
  if (!v || v.kind !== 'sales_orders' || !Number.isInteger(v.version) || (v.version as number) < 0 || typeof v.can_write !== 'boolean' || !Array.isArray(v.situations) || v.situations.length > 5
    || (save && typeof v.replayed !== 'boolean')) throw new Error('APPROVAL_INVALID');
  const situations = (v.situations as ApprovalSituation[]).map(s => {
    if (!s || !UUID.test(s.id) || typeof s.name !== 'string' || typeof s.color !== 'string' || typeof s.active !== 'boolean') throw new Error('APPROVAL_INVALID');
    return { id: s.id, name: s.name, color: s.color, active: s.active };
  });
  return { version: v.version as number, can_write: v.can_write, situations, ...(save ? { replayed: v.replayed as boolean } : {}) };
}
