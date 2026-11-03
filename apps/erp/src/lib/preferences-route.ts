import {preferencePageByRoute} from '../../../../packages/erp-domain/src/preferences/catalog.mjs';
import {importKindOf} from '../../../../packages/erp-domain/src/spreadsheet-import.mjs';

/** Sistema screens Origin opens from Preferências › Sistema; they live under the same address and boundary. */
export const SYSTEM_SCREENS={'consulta-exclusoes':'Consulta de exclusões realizadas','gerenciador-arquivos':'Gerenciador de arquivos','gerenciador-transicoes':'Gerenciador de transições',
 'relatorios-customizados':'Relatórios customizados','etiquetas-customizadas':'Etiquetas customizadas','registro-atividades':'Registro de atividades',usuarios:'Usuários'} as const;
export type SystemScreen=keyof typeof SYSTEM_SCREENS;
/** Suprimentos screens of the same module (migration 148): Gerenciar grupos de tags and Gerenciar tags. */
export const SUPPLY_SCREENS={'grupos-tags':'Gerenciar grupos de tags',tags:'Gerenciar tags'} as const;
export type SupplyScreen=keyof typeof SUPPLY_SCREENS;
/** Paths served by the Preferências and Sistema module (CompanyPreferences): Preferências and Meu Negócio (/meu-negocio). */
export const isPreferencesPath=(pathname:string)=>pathname==='/preferencias'||pathname.startsWith('/preferencias/')||pathname==='/meu-negocio';
/** Key that keeps one settings page mounted while its subsection changes (/preferencias/<categoria>/<pagina>/<subseção>). */
export function preferencesResetKey(pathname:string){const parts=pathname.split('/').filter(Boolean);return parts[0]==='preferencias'?`/${parts.slice(0,3).join('/')}`:pathname;}
/** /preferencias[/<categoria>] is the hub; /preferencias/<categoria>/<pagina>[/<subseção>] is a settings page. */
export function parsePreferencesPath(pathname:string){
 const parts=pathname.split('/').filter(Boolean);
 if(parts[0]!=='preferencias'||parts.length>4||parts.some(p=>!/^[a-z0-9-]{1,48}$/.test(p)))return {kind:'missing' as const};
 if(parts.length<=2)return {kind:'hub' as const,category:parts[1]};
 if(parts[1]==='sistema'&&parts.length===3&&parts[2]==='atualizacoes')return {kind:'updates' as const};
 // 228: Importações de Dados (/preferencias/importacoes/<tipo>) and Consultar gestão de ações (menu do usuário).
 if(parts[1]==='importacoes'&&parts.length===3){const kind=importKindOf(parts[2]!);if(kind)return {kind:'import' as const,importKind:kind};}
 if(parts[1]==='sistema'&&parts.length===3&&parts[2]==='gestao-acoes')return {kind:'actions' as const};
 // Leva H (PRF-029): Backup e Exportação de Dados › Backup.
 if(parts[1]==='backup'&&parts.length===3&&parts[2]==='exportacao')return {kind:'backup' as const};
 if(parts[1]==='sistema'&&parts.length===3&&Object.hasOwn(SYSTEM_SCREENS,parts[2]))return {kind:'screen' as const,screen:parts[2] as SystemScreen};
 if(parts[1]==='suprimentos'&&parts.length===3&&Object.hasOwn(SUPPLY_SCREENS,parts[2]))return {kind:'supply' as const,screen:parts[2] as SupplyScreen};
 const page=preferencePageByRoute(parts[1],parts[2]);
 if(!page||parts.length===4&&!(page.subsections&&page.sections.some(s=>s.id===parts[3])))return {kind:'missing' as const};
 return {kind:'page' as const,page,section:parts[3]};
}
