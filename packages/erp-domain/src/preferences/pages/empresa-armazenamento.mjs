// Empresa > Alterar dados da empresa > Gerenciamento > Espaço e armazenamento.
// The administrator configures this installation's capacity (0 = no limit). Inserted by migration 188 and
// shown inside the "Espaço e armazenamento" panel (not as a hub entry).
import{definePage,PREFERENCE_READERS}from'../core.mjs';
import{integer}from'../fields.mjs';
const S='limite';
export default definePage({id:'empresa-armazenamento',category:'empresa',path:'armazenamento',title:'Espaço e armazenamento',scope:'company',readRoles:PREFERENCE_READERS.all,subsections:false,since:'188',
 sections:[{id:S,title:'Limite de armazenamento'}],
 fields:[
  integer('armazenamento.limite_gb',S,'Limite de armazenamento (GB)',0,100000,0,{status:'applied',hint:'Informe a capacidade de armazenamento reservada para esta instalação. 0 deixa sem limite.',
   note:'Aplicado: com um limite, a página inicial e o menu do usuário mostram o uso sobre o limite, em laranja acima de 90%. 0 = sem limite.'}),
 ]});
