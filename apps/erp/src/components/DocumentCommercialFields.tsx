import type {CommercialData,CommercialTransport,CommercialReference} from '../lib/real-documents-model';
import {documentDecimalDisplay,documentDecimalInput,limitedDecimal,roundedDecimal} from '../lib/document-decimals';

import {FREIGHT_MODES} from '../lib/document-commercial-model';
import {useState,type ReactNode} from 'react';
import type {SectionMode} from '../lib/document-preferences';
export const emptyCommercial=():CommercialData=>({introduction:null,attention_to:null,seller_reference:null,store_reference:null,business_unit_reference:null,transport:null});
export const emptyTransport=():CommercialTransport=>({freight_mode:null,volume_count:null,gross_weight:null,delivery_days:null,carrier_reference:null,service_reference:null,tracking_code:null});

/** A declared source reference is plain text, never a catalog/account/user link. */
export function CommercialReferenceFields({id,label,value,onChange,disabled=false}:{id:string;label:string;value:CommercialReference|null;onChange:(value:CommercialReference|null)=>void;disabled?:boolean}){
 return <fieldset className="document-reference" disabled={disabled}><legend>{label} · referência Origin</legend>
  <div className="document-reference-fields"><div className="form-field"><label htmlFor={`${id}-id`}>ID no Origin</label><input id={`${id}-id`} inputMode="numeric" maxLength={40} value={value?.source_id??''} onChange={event=>onChange(event.target.value||value?.label?{system:'origin',source_id:event.target.value,label:value?.label??null}:null)}/></div>
  <div className="form-field"><label htmlFor={`${id}-label`}>Descrição da referência</label><input id={`${id}-label`} maxLength={200} value={value?.label??''} disabled={!value} onChange={event=>onChange(value?{...value,label:event.target.value||null}:null)}/></div></div>
  {value&&<button type="button" className="text-button" onClick={()=>onChange(null)}>Limpar referência de {label.toLocaleLowerCase('pt-BR')}</button>}
 </fieldset>;
}

/**
 * `transportMode` is Preferências "Exibe a transportadora" (Sim | Opcional | Não): Opcional starts collapsed and Não hides the
 * block while it has no value. `computedWeight` ("Somar peso bruto dos produtos") turns Peso bruto into the read-only sum.
 */
/** purchase: Origin pedido de compra, without the sales fields (shown only when an older pedido carries them) and with whole volumes. */
/** `carrier` (202610200168): the Transportador of the cadastro, shown first in the transport block; `carrierFilled` keeps the block open. */
export default function DocumentCommercialFields({value,onChange,disabled,transportMode='sim',computedWeight,purchase=false,carrier,carrierFilled=false,weightDecimals=null}:{value:CommercialData|null;onChange:(value:CommercialData|null)=>void;disabled:boolean;transportMode?:SectionMode;computedWeight?:string|null;purchase?:boolean;carrier?:ReactNode;carrierFilled?:boolean;
  /** 202610200199 Preferências › Empresa "Número de casas decimais no peso do produto" (null keeps the six decimals of the document). */
  weightDecimals?:number|null}){
 const current=value??emptyCommercial(),transport=current.transport??emptyTransport();
 // The default "0 - Remetente (CIF)" of a new pedido alone is not a value to keep visible.
 const transportFilled=carrierFilled||Object.entries(transport).some(([key,item])=>item!==null&&item!==''&&!(key==='freight_mode'&&item==='0'));
 // A filled block starts open, so a read-only document still shows what it carries.
 const [transportOpen,setTransportOpen]=useState(transportMode==='sim'||transportFilled);
 const transportShown=transportMode==='sim'||transportOpen,transportOffered=transportMode!=='nao'||transportFilled;
 const patch=<K extends keyof CommercialData>(key:K,next:CommercialData[K])=>{if(!disabled)onChange({...current,[key]:next});};
 const salesFields=!purchase||Boolean(current.introduction||current.attention_to||current.seller_reference||current.store_reference||current.business_unit_reference);
 const patchTransport=<K extends keyof CommercialTransport>(key:K,next:CommercialTransport[K])=>patch('transport',{...transport,[key]:next});
 return <fieldset disabled={disabled} className="document-section"><legend>Informações comerciais e transporte</legend>
  {salesFields&&<><div className="document-grid"><div className="form-field document-wide"><label htmlFor="doc-introduction">Introdução</label><textarea id="doc-introduction" maxLength={4000} rows={3} value={current.introduction??''} onChange={event=>patch('introduction',event.target.value||null)}/></div>
  <div className="form-field document-wide"><label htmlFor="doc-attention-to">Aos cuidados de</label><input id="doc-attention-to" maxLength={200} value={current.attention_to??''} onChange={event=>patch('attention_to',event.target.value||null)}/></div></div>
  <p className="real-help">Referências comerciais declaradas de origem Origin. Os IDs e descrições não associam vendedor, usuário, loja ou cadastro do FAGOO. Campos vazios permanecem não informados.</p>
  <div className="document-reference-grid">{([['seller_reference','Vendedor'],['store_reference','Loja'],['business_unit_reference','Unidade de negócio']] as const).map(([key,label])=><CommercialReferenceFields key={key} id={`doc-${key}`} label={label} value={current[key]} disabled={disabled} onChange={next=>patch(key,next)}/>)}</div></>}
  {transportOffered&&transportMode!=='sim'&&<button type="button" className="text-button document-section-toggle" aria-expanded={transportShown} onClick={()=>setTransportOpen(open=>!open)}>{transportShown?'Ocultar transportador':'Mostrar transportador'}</button>}
  {transportOffered&&transportShown&&<><h3>Transporte declarado</h3>{carrier&&<div className="document-carrier">{carrier}</div>}<div className="document-grid"><div className="form-field"><label htmlFor="doc-freight-mode">Frete por conta</label><select id="doc-freight-mode" value={transport.freight_mode??''} onChange={event=>patchTransport('freight_mode',event.target.value?event.target.value as NonNullable<CommercialTransport['freight_mode']>:null)}><option value="">Não informado</option>{Object.entries(FREIGHT_MODES).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></div>
  {([['volume_count','Quantidade de volumes'],['gross_weight','Peso bruto declarado']] as const).map(([key,label])=>key==='gross_weight'&&computedWeight!==undefined?<div key={key} className="form-field"><label htmlFor="doc-gross_weight">Peso bruto</label><input id="doc-gross_weight" type="text" readOnly value={documentDecimalDisplay(computedWeight&&weightDecimals!==null?roundedDecimal(computedWeight,weightDecimals):computedWeight??'')}/><small>Soma do peso bruto dos produtos × quantidade (Preferências), em Kg.</small></div>:<div key={key} className="form-field"><label htmlFor={`doc-${key}`}>{label}</label><input id={`doc-${key}`} type="text" inputMode="decimal" maxLength={19} value={documentDecimalDisplay(transport[key]??'')} onChange={event=>{const raw=purchase&&key==='volume_count'?event.target.value.replace(/[^0-9]/g,''):event.target.value,text=key==='gross_weight'&&weightDecimals!==null?limitedDecimal(raw,weightDecimals):raw;patchTransport(key,text?documentDecimalInput(text):null);}}/><small>{purchase&&key==='volume_count'?'Número inteiro de volumes.':key==='gross_weight'&&weightDecimals!==null?`Até 12 dígitos inteiros e ${weightDecimals} casa(s) decimal(is), em Kg (Preferências › Empresa).`:'Até 12 dígitos inteiros e 6 casas decimais, sem arredondamento.'}</small></div>)}
  <div className="form-field document-wide"><label htmlFor="doc-tracking-code">Código de rastreamento</label><input id="doc-tracking-code" maxLength={200} value={transport.tracking_code??''} onChange={event=>patchTransport('tracking_code',event.target.value||null)}/></div></div>
  {/* 202610200238 (wave E): the Transportador comes from the cadastro (picker above); the Origin reference of an imported document is shown read-only. */}
  {transport.carrier_reference&&<p className="documents-picked document-reference-readonly"><span>Transportador no Origin: {transport.carrier_reference.label??'sem descrição'} · ID {transport.carrier_reference.source_id}</span></p>}
  <div className="document-reference-grid"><CommercialReferenceFields id="doc-service_reference" label="Serviço de transporte" value={transport.service_reference} disabled={disabled} onChange={next=>patchTransport('service_reference',next)}/></div></>}
 </fieldset>;
}
