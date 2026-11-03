// Preferências > Sistema > Interface (Origin preferencias.php#sistema/interface-sistema). Each user keeps their own value.
import{definePage,PREFERENCE_READERS}from'../core.mjs';
import{toggle}from'../fields.mjs';
export default definePage({id:'sistema-interface',category:'sistema',path:'interface',title:'Interface',scope:'user',readRoles:PREFERENCE_READERS.all,subsections:false,
 sections:[{id:'interface',title:'Interface'}],
 fields:[
  toggle('sistema.tema_escuro','interface','Habilita tema escuro',false,{status:'applied',note:'Vale para o seu usuário. Ao salvar, o tema muda neste navegador; ao entrar na área da empresa em qualquer navegador, o tema salvo é aplicado. O menu do usuário continua alternando o tema só no navegador atual, até a próxima entrada.'}),
 ]});
