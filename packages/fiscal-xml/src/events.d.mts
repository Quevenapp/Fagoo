export class FiscalEventXmlError extends Error { code: string; }
export const CORRECTION_CONDITION: string;
export function saoPauloMoment(date: Date): string;
export function cancelEventXml(input: { key: string; cnpj: string; protocol: string; justification: string; at?: Date; environment: string }): string;
export function correctionEventXml(input: { key: string; cnpj: string; text: string; sequence: number; at?: Date; environment: string }): string;
export function inutilizationXml(input: { cnpj: string; model: '55' | '65'; series: number; from: number; to: number; justification: string; year: string; cuf?: string; environment: string }): string;
