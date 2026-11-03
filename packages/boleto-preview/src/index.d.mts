import type { BoletoInput } from '../../boleto-core/src/index.mjs';
export class BoletoPreviewError extends Error { readonly code: string; }
export interface PrintAddress {
  address: string; neighborhood: string; city: string; state: string; postalCode: string;
}
export interface Itau109PrintInput {
  purpose: 'offline-print-preview';
  boleto: BoletoInput;
  document: { number: string; issuedOn: string; processedOn: string };
  beneficiaryAddress: PrintAddress;
  payer: PrintAddress & { type: '01' | '02'; document: string; name: string };
}
export interface Itau109PrintPreview {
  readonly purpose: 'offline-print-preview'; readonly renderProfile: 'itau109-print-preview-v1';
  readonly mimeType: 'text/html'; readonly html: string; readonly htmlHash: string; readonly sizeBytes: number;
  readonly binding: Readonly<{ bank: '341'; wallet: '109'; barcode: string; digitableLine: string;
    amountCents: string; dueOn: string; referenceOn: string; ourNumberWithDigit: string; documentNumber: string }>;
  readonly fullBoletoRendered: true; readonly printedLayoutValidatedByBank: false;
  readonly bankRegistered: false; readonly bankAcceptanceVerified: false; readonly homologationVerified: false;
  readonly numberAllocationVerified: false; readonly financialMutationPerformed: false;
  readonly bankTransmissionPerformed: false; readonly canIssue: false; readonly canTransmit: false; readonly canPay: false;
  readonly pending: readonly string[];
  readonly dimensions: Readonly<{ paper: 'A4'; slipWidthMm: 190; slipHeightMm: 104; barcodeWidthMm: 103;
    barcodeHeightMm: 13; quietZoneMm: 5; barcodeCenterFromBottomMm: 13.5 }>;
}
/** All fields are explicit. Only an offline specimen; no operational bank capability. */
export function createItau109PrintPreview(input: Itau109PrintInput): Promise<Itau109PrintPreview>;
export interface Itau109PrintEncoding {
  readonly profile:'itau109-no-charges-v1'|'itau109-origin-observed-v1';
  readonly policyHash:string; readonly approvalVersion:number;
  readonly compatibilityConfirmed:boolean; readonly permanentInstructionsAcknowledged:boolean;
  readonly terms:null|Readonly<{
    profile:'itau109-origin-observed-v1';version:1;dailyInterestCents:string;interestDateField:string;
    penaltyPercentHundredths:'200';penaltyDateField:string;zeroDailyInterestConfirmed:boolean;
  }>;
}
export type Itau109OperationalPrintPreviewV2 = Omit<Itau109PrintPreview,'renderProfile'> & Readonly<{
  renderProfile:'itau109-print-preview-v2';encoding:Itau109PrintEncoding;
}>;
/** Captured terms are descriptive fields, never a payable late-payment total. */
export function createItau109OperationalPrintPreviewV2(input:{snapshot:unknown;billingTitleId:string;beneficiaryAddress:PrintAddress}):Promise<Itau109OperationalPrintPreviewV2>;
