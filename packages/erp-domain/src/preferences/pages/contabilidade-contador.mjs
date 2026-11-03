// Preferências > Contabilidade > Espaço Meu Contador (Origin: subseções Arquivos, Dados do contador e Data).
import{definePage,PREFERENCE_READERS}from'../core.mjs';
import{applied,email,integer,text}from'../fields.mjs';
const A='arquivos',D='dados',T='data';
const note='Guardado para o pacote mensal do contador, que ainda não é gerado pelo FAGOO.';
export default definePage({id:'contabilidade-contador',category:'contabilidade',path:'meu-contador',title:'Espaço Meu Contador',scope:'company',readRoles:PREFERENCE_READERS.accountant,subsections:true,
 sections:[{id:A,title:'Arquivos'},{id:D,title:'Dados do contador'},{id:T,title:'Data'}],
 fields:[
  // Notas fiscais lane (wave E): the package of a competência with the XMLs of the notes, built in the browser.
  applied('contador.arquivos',A,'Arquivos','Gera o pacote de uma competência com os XMLs autorizados das NF-e de saída, NFC-e e notas de entrada (acervo do Origin e XMLs importados no FAGOO), as cartas de correção e um resumo.csv, num ZIP baixado pelo navegador. O envio automático por e-mail, o SPED e o Sintegra ainda não existem no FAGOO.',
   {link:{label:'Gerar pacote de XMLs da competência',to:'/historico-fiscal?modelo=55&acao=pacote-contador',roles:['admin','fiscal']}}),
  text('contador.nome',D,'Nome',120,{note}),
  text('contador.crc',D,'CRC',20,{note}),
  email('contador.email',D,'E-mail',{note}),
  text('contador.telefone',D,'Telefone',20,{note}),
  text('contador.escritorio',D,'Escritório',120,{note}),
  integer('contador.dia_fechamento',T,'Dia do fechamento mensal',0,31,0,{hint:'0 significa não informado.',note}),
  integer('contador.dia_entrega',T,'Dia da entrega dos arquivos',0,31,0,{hint:'0 significa não informado.',note}),
 ]});
