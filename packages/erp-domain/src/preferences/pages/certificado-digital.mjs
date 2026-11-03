// Preferências > Certificado Digital > Configurações de certificado digital (Origin preferencias.php#certificado-digital/certificado-digital-configuracoes).
// Nothing is stored here: Brufap keeps only the A1 in server custody (migration 041), so the other Origin types stay unavailable.
import{definePage,PREFERENCE_READERS}from'../core.mjs';
import{applied,info}from'../fields.mjs';
const T='tipos';
export default definePage({id:'certificado-digital',category:'certificado',path:'configuracoes',title:'Configurações de certificado digital',scope:'company',readRoles:PREFERENCE_READERS.certificate,subsections:false,
 sections:[{id:T,title:'Tipos de certificados'}],
 fields:[
  applied('certificado.a1_servidor',T,'A1 - Servidor','O certificado A1 fica guardado no servidor do FAGOO, com custódia própria, e assina as notas de homologação.',{link:{label:'Abrir certificado A1',to:'/certificado-a1',roles:['admin','fiscal']}}),
  info('certificado.a1_maquina',T,'A1 - Máquina do cliente','Não disponível: o FAGOO não usa certificado instalado no computador de quem emite.'),
  info('certificado.a3',T,'A3','Não disponível: o FAGOO não usa certificado em cartão ou token.'),
 ]});
