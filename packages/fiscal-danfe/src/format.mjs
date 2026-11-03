import {need} from './extract.mjs';
export const escapeHtml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
export function decimalPt(value,min=0){
 if(value===null)return '-';need(typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value),'PRINT_DECIMAL_INVALID');
 const [whole,raw='']=value.split('.');const fraction=raw.replace(/0+$/,'').padEnd(min,'0');return whole.replace(/\B(?=(\d{3})+(?!\d))/g,'.')+(fraction?','+fraction:'');
}
export const moneyPt=value=>decimalPt(value,2);
export function localDate(value){if(value===null)return '-';return new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'medium',hourCycle:'h23'}).format(new Date(value));}
export const keyPt=value=>value.match(/.{4}/g).join(' ');
export const documentPt=value=>value.length===14?value.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,'$1.$2.$3/$4-$5'):value.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/,'$1.$2.$3-$4');
export const addressText=a=>`${a.street}, ${a.number}${a.complement?' · '+a.complement:''} · ${a.district} · ${a.city}/${a.state} · CEP ${a.postal_code.slice(0,5)}-${a.postal_code.slice(5)}${a.phone?' · Fone '+a.phone:''}`;
// Explicit conservative wrapping; never ellipsize a fiscal value or description.
export function wrap(value,capacity){let line='',width=0;const result=[];for(const c of String(value)){if(c==='\n'){result.push(line);line='';width=0;continue;}const cost=c.codePointAt(0)>0x2ff?4:1;if(width+cost>capacity){result.push(line);line='';width=0;}line+=c;width+=cost;}result.push(line);return result;}
