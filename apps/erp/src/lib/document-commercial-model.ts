import {normalizeCommercialReference,type CommercialReference} from '../../../../packages/erp-domain/src/index.mjs';
// Origin "Frete por conta" labels (the codes are the NF-e modFrete).
export const FREIGHT_MODES={'0':'0 - Contratação do Frete por conta do Remetente (CIF)','1':'1 - Contratação do Frete por conta do Destinatário (FOB)','2':'2 - Contratação do Frete por conta de Terceiros','3':'3 - Transporte Próprio por conta do Remetente','4':'4 - Transporte Próprio por conta do Destinatário','9':'9 - Sem Ocorrência de Transporte'} as const;
export function commercialReferenceText(value:CommercialReference|null|undefined):string|null{
 const reference=normalizeCommercialReference(value??null);
 return reference?`Origin · ID ${reference.source_id}${reference.label?` · ${reference.label}`:''}`:null;
}
