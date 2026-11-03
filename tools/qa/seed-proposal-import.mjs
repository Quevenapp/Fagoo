/** Local synthetic proposal import states; no network or real data. */
import {randomUUID,createHash} from 'node:crypto';

export async function seedProposalImport(db,userId){
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
 await db.exec("insert into origin_sync.resource_state(resource)values('qa_proposals_055') on conflict do nothing");
 const stage=async(entity,id,payload)=>{
  const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  await db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values($1,'qa_proposals_055',$2,$3::jsonb,$4)",[entity,id,JSON.stringify(payload),hash]);return hash;
 };
 for(const [entity,id,data]of [
  ['contacts','9551000001',{id:'9551000001',nome:'Contato fictício de importação 055',tipo:'J',situacao:'A'}],
  ['products','9551000002',{id:'9551000002',nome:'Produto fictício de importação 055',tipo:'P',formato:'S',situacao:'A',unidade:'UN',preco:40}]
 ]){
  const source_hash=await stage(entity,id,data);
  await scalar('select public.erp_catalog_import_origin($1,$2,$3::jsonb,$4,false)value',[userId,entity,JSON.stringify([{source_id:id,source_hash}]),randomUUID()]);
 }
 const source=id=>({id,numero:Number(id.slice(-3)),data:'2026-10-16',situacao:'Rascunho',contato:{id:'9551000001'},
  total:76,totalProdutos:80,desconto:5,outrasDespesas:1,totalOutrosItens:0,garantia:0,dataProximoContato:'0000-00-00',
  introducao:'Introdução original fictícia do Origin.',aosCuidadosDe:'Equipe fictícia',vendedor:{id:'9551000090'},loja:{id:0},
  transporte:{frete:0,freteModalidade:0,quantidadeVolumes:2,pesoBruto:1.234567,prazoEntrega:0,contato:{id:0,nome:''},volumes:{id:0,servico:'',codigoRastreamento:''}},
  itens:[{produto:{id:'9551000002',descricao:'Produto fictício'},codigo:'QA055',unidade:'UN',quantidade:2,valor:40,desconto:10,descricaoDetalhada:'Detalhe comercial fictício.\nLinha preservada.'}],
  parcelas:[{dataVencimento:'2026-11-15',numeroDias:30,valor:76,observacoes:'Condição fictícia da parcela.',formaPagamento:{id:'9551000095'}}],
  observacoes:'Observação pública fictícia.',observacaoInterna:'Anotação interna fictícia.',prazoEntrega:'Prazo comercial fictício.'});
 const importSource=async(id,version)=>{
  const suffix=version===2?'_v2':'',command=randomUUID();
  const preview=await scalar(`select public.erp_origin_proposal_import_preview${suffix}($1,$2)value`,[userId,id]);
  if(!preview.can_apply)throw new Error('QA_PROPOSAL_NOT_ELIGIBLE');
  return scalar(`select public.erp_origin_proposal_import_apply${suffix}($1,$2,$3,$4,true,true)value`,[userId,id,preview.preview_hash,command]);
 };
 await stage('sales_proposals','9551000101',source('9551000101'));
 const blocked=source('9551000102');blocked.itens[0].unidade='';await stage('sales_proposals',blocked.id,blocked);
 const legacy=source('9551000103');Object.assign(legacy,{total:80,desconto:0,outrasDespesas:0,dataProximoContato:null,introducao:'',aosCuidadosDe:'',vendedor:{id:0},transporte:{frete:0,freteModalidade:9},parcelas:[]});legacy.itens[0].desconto=0;legacy.itens[0].descricaoDetalhada='';
 await stage('sales_proposals',legacy.id,legacy);await importSource(legacy.id,1);
 const edited=source('9551000104');await stage('sales_proposals',edited.id,edited);const ack=await importSource(edited.id,2);
 const current=await scalar('select public.erp_document_get($1,\'sales_proposals\',$2)value',[userId,ack.receipt.document.id]);
 const d=current.document,body={};for(const k of ['date','contact_id','warehouse_id','expected_date','valid_until','next_contact','template','discount_mode','discount_value','freight','other_expenses','notes','internal_notes','payment_terms','delivery_terms','equipment','serial_number','technician','defect','solution','commercial'])if(Object.hasOwn(d,k))body[k]=d[k];
 body.items=d.items.map(({gross,discount,total,position,product_snapshot,...item})=>item);body.installments=d.installments.map(({position,...p})=>p);
 body.commercial.introduction='Introdução atual alterada no Brufap fictício.';
 await scalar("select public.erp_document_save($1,'sales_proposals',$2,$3,$4,$5::jsonb)value",[userId,d.id,d.version,randomUUID(),JSON.stringify(body)]);
}
