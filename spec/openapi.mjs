import { businessOpenApi } from './openapi.business.mjs';
const success={'200':{description:'Resposta autorizada'},'401':{description:'Autenticação necessária'},'403':{description:'Permissão insuficiente'}};
export function openApi(origin,version){return{...businessOpenApi,openapi:'3.1.0',info:{title:'FAGOO API',version,license:{name:'AGPL-3.0-only',url:'https://www.gnu.org/licenses/agpl-3.0.html'}},servers:[{url:origin}],security:[{integrationToken:[]}],components:{...businessOpenApi.components,securitySchemes:{integrationToken:{type:'http',scheme:'bearer',description:'Credencial individual da integração ou token OAuth com escopo fagoo.'}}},paths:{...businessOpenApi.paths,
 '/.well-known/fagoo.json':{get:{summary:'Descobrir instalação e autenticação',security:[],responses:success}},
 '/api/v1/me':{get:{summary:'Identidade, empresa, permissões e capacidades',responses:success}},
 '/api/v1/integrations':{get:{summary:'Listar integrações (administrador)',responses:success},post:{summary:'Criar credencial restrita (administrador)',responses:success}},
 '/api/v1/integrations/webhooks':{get:{summary:'Listar webhooks (administrador)',responses:success},post:{summary:'Criar webhook HTTPS assinado (administrador)',responses:success}},
 '/api/v1/integrations/webhooks/{id}':{delete:{summary:'Desativar webhook (administrador)',parameters:[{name:'id',in:'path',required:true,schema:{type:'string',format:'uuid'}}],responses:success}},
 '/api/v1/integrations/webhooks/{id}/deliveries':{get:{summary:'Inspecionar entregas e falhas (administrador)',parameters:[{name:'id',in:'path',required:true,schema:{type:'string',format:'uuid'}},{name:'before',in:'query',schema:{type:'string'}},{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:100}}],responses:success}},
 '/api/v1/integrations/webhooks/deliveries/{id}/retry':{post:{summary:'Reenfileirar entrega que falhou (administrador)',parameters:[{name:'id',in:'path',required:true,schema:{type:'string',format:'uuid'}}],responses:success}},
 '/api/v1/system/updates':{get:{summary:'Estado do atualizador local (administrador)',responses:success}},
 '/api/v1/system/updates/check':{post:{summary:'Verificar release pública assinada',responses:success}},
 '/api/v1/system/updates/request':{post:{summary:'Solicitar aplicação de versão previamente verificada',responses:{...success,'202':{description:'Atualização enfileirada'},'503':{description:'Atualizador indisponível'}}}},
 '/api/v1/mobile/client':{post:{summary:'Preparar cliente público nativo com PKCE (administrador)',responses:success}}
}};}
