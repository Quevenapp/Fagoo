/** Small builders for page schemas. Every stored field starts as "stored" (kept for upcoming use); a page marks a field
 * "applied" only when Brufap already behaves according to its value. */
const stored=(extra)=>({status:'stored',...extra});
export const toggle=(key,section,label,value=false,extra={})=>stored({key,section,label,kind:'toggle',default:value,...extra});
export const choice=(key,section,label,options,value,extra={})=>stored({key,section,label,kind:'choice',options,default:value,...extra});
export const radio=(key,section,label,options,value,extra={})=>choice(key,section,label,options,value,{widget:'radio',...extra});
export const multi=(key,section,label,options,value=[],extra={})=>stored({key,section,label,kind:'multi',options,default:value,...extra});
export const integer=(key,section,label,min,max,value,extra={})=>stored({key,section,label,kind:'integer',min,max,default:value,...extra});
export const decimal=(key,section,label,{min=0,max,scale},value,extra={})=>stored({key,section,label,kind:'decimal',min,max,scale,default:value,...extra});
export const text=(key,section,label,maxLength,extra={})=>stored({key,section,label,kind:'text',maxLength,default:'',...extra});
export const email=(key,section,label,extra={})=>text(key,section,label,120,{format:'email',...extra});
export const emails=(key,section,label,extra={})=>text(key,section,label,100,{format:'email_list',maxItems:5,hint:'Separe os endereços por vírgula.',...extra});
export const area=(key,section,label,maxLength=2000,extra={})=>stored({key,section,label,kind:'textarea',maxLength,default:'',...extra});
export const users=(key,section,label,extra={})=>stored({key,section,label,kind:'users',maxItems:100,default:[],...extra});
export const documents=(key,section,label,maxItems,extra={})=>stored({key,section,label,kind:'documents',maxItems,default:[],...extra});
export const keymap=(key,section,label,options,value,extra={})=>stored({key,section,label,kind:'keymap',options,default:value,...extra});
export const info=(id,section,label,text,extra={})=>({id,info:true,section,label,text,status:'unavailable',...extra});
export const applied=(id,section,label,text,extra={})=>info(id,section,label,text,{status:'applied',...extra});
/** Origin's e-mail block repeated on several pages; sending e-mail is not built yet, so every value is kept for it. */
export function emailBlock(prefix,section,{subject='Assunto padrão',copy='Email padrão de cópia',sender='Nome padrão do remetente',reply='Email padrão de resposta',message='Mensagem padrão',subjectLength=100}={}){
 const note='Guardado. O FAGOO ainda não envia e-mails; o texto será usado quando o envio existir.';
 return[text(`${prefix}.email_assunto`,section,subject,subjectLength,{note}),emails(`${prefix}.email_copia`,section,copy,{note}),text(`${prefix}.email_remetente`,section,sender,100,{note}),
  email(`${prefix}.email_resposta`,section,reply,{note}),area(`${prefix}.email_mensagem`,section,message,4000,{note,hint:'O Origin usa texto formatado; o FAGOO guarda o texto simples.'})];
}
/** "Próximo número" of documents: document numbering is not adjustable in Brufap yet. */
export const nextNumber=(id,section)=>info(id,section,'Próximo número','O próximo número ainda não é ajustável no FAGOO; ele segue a numeração atual dos documentos.');
