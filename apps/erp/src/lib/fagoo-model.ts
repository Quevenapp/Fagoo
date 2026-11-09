import type { NativeRequestOptions, CommunicationRequestOptions } from './real-access';

export type FagooUnit = { id: string; name: string; timezone: string; capabilities: string[]; team_ids: string[]; version?: number };
export type FagooContext = { user_id: string; role: string; units: FagooUnit[]; online_required?: boolean };
export type FagooPort = { fagoo(path: string, options?: NativeRequestOptions): Promise<unknown>; crm(path: string, options?: NativeRequestOptions): Promise<unknown>; queues(path: string, options?: NativeRequestOptions): Promise<unknown>; communication(path: string, options?: CommunicationRequestOptions): Promise<unknown> };
export const hasUnitCapability = (context: FagooContext | null | undefined, capability: string) => !!context?.units.some(unit => unit.capabilities.includes(capability));
export function parseFagooContext(value: unknown, actor: string): FagooContext {
 const data = value as FagooContext;
 if (!data || data.user_id !== actor || !Array.isArray(data.units) || data.units.some(unit => typeof unit.id !== 'string' || typeof unit.name !== 'string' || !Array.isArray(unit.capabilities) || unit.capabilities.some(cap => typeof cap !== 'string'))) throw new Error('Contexto de acesso inválido.');
 return data;
}
export const commandId = () => crypto.randomUUID();
export function fagooError(error: unknown) {
 const status = (error as { status?: number })?.status;
 return status === 403 ? 'Seu acesso não permite esta ação.' : status === 409 ? 'Este registro mudou. Atualize a tela antes de salvar novamente.' : status === 400 ? 'Revise os campos informados.' : 'Não foi possível confirmar a operação. Consulte o resultado antes de tentar novamente.';
}
