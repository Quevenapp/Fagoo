import test from'node:test';import assert from'node:assert/strict';
import{mountComponent}from'./helpers/component-recovery-harness.mjs';
import{createReportsFixture,REPORTS_QA_INVOICE}from'../src/qa/reports-fixture.ts';

// Wave D of Preferências, Sistema and Meu Negócio (migrations 228-233), screens. Synthetic data only.
let previous;test.before(()=>{previous=globalThis.document;globalThis.document={activeElement:null,documentElement:{dataset:{}},addEventListener(){},removeEventListener(){},querySelector:()=>null,body:{append(){},classList:{add(){},remove(){}}}};});
test.after(()=>{globalThis.document=previous;});
const labels=(f,location)=>mountComponent('RealLabels.tsx',{controller:f.controller},{location,expandChildren:['OriginListHeader','LabelSvg','Modal']});

test('230 NFE-052 Imprimir etiquetas of a note opens the product labels with one label per unit; the model and the copies can change',async()=>{
 const f=createReportsFixture(),v=await labels(f,`/preferencias/sistema/etiquetas-customizadas?nota=${REPORTS_QA_INVOICE}`);try{
  assert.ok(f.calls.some(c=>c.path===`/v1/sistema/etiquetas/nota?id=${REPORTS_QA_INVOICE}`));
  assert.match(v.text(),/Imprimir etiquetas · Etiqueta de produto/);assert.match(v.text(),/Produtos da nota fiscal \(rascunho, sem número\): uma etiqueta por unidade de cada item/);
  assert.match(v.text(),/P-1 · Peça sintética · 3 etiqueta\(s\)/);assert.match(v.text(),/AV-1 · Item avulso · 1 etiqueta\(s\)/);assert.match(v.text(),/4 etiqueta\(s\) em 1 página\(s\)/);
  await v.change('labels-by-quantity',false);assert.match(v.text(),/2 etiqueta\(s\) em/);await v.change('labels-copies','2');assert.match(v.text(),/4 etiqueta\(s\) em/);
  await v.change('labels-record-item-2',false);assert.match(v.text(),/2 etiqueta\(s\) em/);
  assert.equal(v.button('Visualizar impressão').disabled,false);
 }finally{v.unmount();}
 const missing=await labels(createReportsFixture(),'/preferencias/sistema/etiquetas-customizadas?nota=70000000-0000-4000-8000-000000000999');try{assert.match(missing.text(),/Nota fiscal não encontrada/);}finally{missing.unmount();}
 const bad=await labels(createReportsFixture(),'/preferencias/sistema/etiquetas-customizadas?nota=x');try{assert.match(bad.text(),/Nota fiscal inválida para imprimir etiquetas/);}finally{bad.unmount();}
});

import{createUsersFixture,USERS_QA_ADMIN}from'../src/qa/users-fixture.ts';
import{createBusinessFixture}from'../src/qa/business-fixture.ts';
const VENDAS='30000000-0000-4000-8000-000000000001';
const textOf=n=>Array.isArray(n)?n.map(textOf).join(''):n&&typeof n==='object'?textOf(n.props?.children):n===null||n===undefined||typeof n==='boolean'?'':String(n);
const users=f=>mountComponent('RealUsers.tsx',{controller:f.controller},{expandChildren:true,location:'/preferencias/sistema/usuarios'});
const row=(v,text)=>v.nodes().find(n=>n.type==='td'&&n.props.onClick&&textOf(n).includes(text));
const openControls=async(v,name)=>{row(v,name).props.onClick();await v.flush();await v.click('Tipo, horários e permissões');};

test('229 PRF-206 Tipo de usuário: the column shows Normal or Contador and the filter asks the server for one type',async()=>{
 const f=createUsersFixture();f.controls.set(VENDAS,{version:1,user_type:'contador',schedule:{enabled:false,windows:[]},permissions:null,updated_at:null});
 const v=await users(f);try{
  assert.ok(v.nodes().some(n=>n.type==='td'&&textOf(n)==='Contador'));assert.ok(v.nodes().some(n=>n.type==='td'&&textOf(n)==='Normal'));
  v.nodes().find(n=>n.type==='button'&&n.props['aria-label']==='Abrir filtro').props.onClick();await v.flush();
  await v.change('users-type','contador');v.nodes().find(n=>n.type==='button'&&textOf(n)==='Filtrar').props.onClick();await v.flush();
  assert.ok(f.calls.some(c=>c.method!=='POST'&&/^\/v1\/usuarios\?.*tipo=contador/.test(c.path)),'the filter goes to the server');
  assert.match(v.text(),/Tipo de usuário: Contador/);assert.equal(v.nodes().some(n=>n.type==='td'&&textOf(n)==='Normal'),false);
 }finally{v.unmount();}
});

test('229 PRF-214/PRF-224 Tipo, horários e permissões: windows by weekday, Origin permission tabs and one command with Conferir resultado',async()=>{
 const f=createUsersFixture({lostAck:true}),v=await users(f);try{
  await openControls(v,'Vendas Sintético');
  assert.ok(f.calls.some(c=>c.method==='GET'&&c.path===`/v1/usuarios/${VENDAS}/controles`));
  assert.match(v.text(),/Vendedor vinculado \(Vendedor Sintético\): os horários do vendedor também valem \(09:00–17:00 S T Q Q S\)/);
  await v.change('controls-type','contador');await v.change('controls-schedule',true);
  assert.equal(v.input('controls-start-0').props.value,'08:00');await v.change('controls-end-0','12:30');await v.change('controls-day-0-6',true);
  v.input('controls-mode-custom').props.onChange({target:{checked:true}});await v.flush();
  assert.match(v.text(),/CadastrosSuprimentosVendasFinançasServiçosPreferênciasContabilidadeMeu NegócioOutros/);
  v.nodes().find(n=>n.type==='button'&&n.props.role==='tab'&&textOf(n)==='Meu Negócio').props.onClick();await v.flush();
  assert.match(v.text(),/DashboardAplicada/);assert.equal(v.input('perm-meu_negocio-dashboard-diario').props.checked,true);
  await v.change('perm-meu_negocio-dashboard-diario',false);
  v.nodes().find(n=>n.type==='button'&&n.props.role==='tab'&&textOf(n)==='Outros').props.onClick();await v.flush();
  assert.equal(v.input('perm-outros-usuarios').disabled,true,'kept for the Administrador profile');
  const saves=()=>f.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/controles'));
  const controlsSave=v.nodes().filter(n=>n.type==='button'&&textOf(n)==='Salvar').at(-1);controlsSave.props.onClick();await v.flush();
  assert.equal(saves().length,1);const sent=saves()[0].body;
  assert.deepEqual([sent.expected_version,sent.data.user_type,sent.data.schedule],[0,'contador',{enabled:true,windows:[{start:'08:00',end:'12:30',days:[1,2,3,4,5,6]}]}]);
  assert.equal(sent.data.permissions.includes('meu_negocio.dashboard.diario'),false);assert.equal(sent.data.permissions.includes('meu_negocio.dashboard.mensal'),true);
  assert.match(v.text(),/Use "Conferir resultado"/);await v.click('Conferir resultado');
  assert.equal(saves().length,2);assert.deepEqual(saves()[1].body,sent,'the same command');assert.match(v.text(),/Horários e permissões salvos \(comando já registrado\)/);
 }finally{v.unmount();}
 const g=createUsersFixture(),w=await users(g);try{
  await openControls(w,'Administrador Sintético');assert.equal(w.input('controls-schedule').disabled,true);assert.equal(w.input('controls-mode-custom').disabled,true);
  assert.match(w.text(),/O administrador tem todas as permissões e nunca é bloqueado por horário/);assert.equal(g.calls.some(c=>c.path.includes(USERS_QA_ADMIN)&&c.path.endsWith('/controles')),true);
 }finally{w.unmount();}
});

test('229 PRF-222 Meu Negócio: a dashboard without its permission is listed disabled and the panel says why',async()=>{
 const perms={scope:'access_permissions',data_mode:'erp_native',user_id:'40000000-0000-4000-8000-000000000150',role:'vendas',user_type:'normal',permissions:['meu_negocio.dashboard','meu_negocio.dashboard.mensal'],access:{open:true,until:null}};
 const f=createBusinessFixture({role:'vendas',before:call=>call.path==='/v1/sistema/permissoes'?{...perms,user_id:f.controller.getSnapshot().membership.user_id}:undefined});
 const v=await mountComponent('BusinessDashboards.tsx',{controller:f.controller},{location:'/meu-negocio?painel=diario',expandChildren:true});try{
  assert.ok(v.nodes().some(n=>n.type==='span'&&n.props['aria-disabled']==='true'&&textOf(n)==='Diário'));
  assert.ok(v.nodes().some(n=>n.type==='test-router-link'&&textOf(n)==='Mensal'));
  assert.match(v.text(),/Dashboard não liberadoSeu usuário não tem a permissão deste dashboard/);
  assert.equal(f.calls.some(c=>c.path.startsWith('/v1/meu-negocio/diario')),false,'the refused panel is not asked');
 }finally{v.unmount();}
});

test('229 PRF-291 Empresa › Minha conta: Controle de horários opens Sistema › Usuários for the administrador and stays disabled for the others',async()=>{
 const port=write=>({async company(path){
  if(path==='/v1/empresa')return{read_identity:true,write_identity:write,read_fiscal:false,write_fiscal:false,data_mode:'erp_native',emission_enabled:false};
  return{section:'identity',record:{version:1,data:{legal_name:'Empresa Sintética Ltda',trade_name:'Sintética',cnpj:'11222333000181',ie:null,postal_code:'01001000',street:'Rua Sintética',number:'1',complement:null,district:'Centro',city:'São Paulo',municipality_code:'3550308',state:'SP',phone:null,email:null},created_at:'2026-10-20T12:00:00Z',updated_at:'2026-10-20T12:00:00Z'},data_mode:'erp_native',emission_enabled:false};}});
 for(const write of[true,false]){const v=await mountComponent('CompanySettings.tsx',{controller:port(write)},{location:'/empresa-configuracoes',expandChildren:true});try{
  const link=v.nodes().find(n=>n.props?.to==='/preferencias/sistema/usuarios');
  assert.equal(Boolean(link&&textOf(link).includes('Controle de horários')),write);
  if(!write)assert.ok(v.nodes().some(n=>n.type==='span'&&n.props['aria-disabled']==='true'&&textOf(n).includes('Controle de horários')&&/Somente administradores/.test(n.props.title)));
 }finally{v.unmount();}}
});

import{createListPreferencesFixture,LIST_QA_ACTOR}from'../src/qa/list-preferences-fixture.ts';
test('PRD-054 Informações visíveis: the Origin drawer with the user name, Todos, keyboard order, Aplicar and Restaurar listagem padrão',async()=>{
 const f=createListPreferencesFixture(),profiles=[];
 const system=async(path,options)=>{profiles.push([path,options.method]);return{scope:'access_profile',data_mode:'erp_native',user_id:LIST_QA_ACTOR,role:'vendas',name:'Ana Sintética',email:'ana@sintetico.test',company:null};};
 const v=await mountComponent('../../test/helpers/list-preferences-probe.tsx',{controller:f.controller,drawer:{note:'Descrição fica sempre visível.',system}},{expandChildren:true});
 const posts=()=>f.calls.filter(c=>c.method==='POST'),columns=()=>v.nodes().find(n=>n.type==='p'&&n.props['data-columns']!==undefined).props['data-columns'];
 try{
  assert.equal(v.text().includes('Informações visíveis'),false);await v.click('Listagem customizada');
  assert.deepEqual(profiles,[['/v1/sistema/perfil','GET']]);
  for(const s of['Informações visíveis','Colunas customizadas','Selecione abaixo quais colunas deseja que estejam visíveis na listagem','Configurações por usuário',
   'Essa configuração só aparecerá para o usuário Ana Sintética.','Descrição fica sempre visível.','Todos','Cancelar','Aplicar'])assert.ok(v.text().includes(s),s);
  assert.equal(v.text().includes('Restaurar listagem padrão'),false,'nothing to restore yet');
  assert.equal(v.input('list-column-all').props.checked,false);await v.change('list-column-all',true);assert.equal(v.input('list-column-data').props.checked,true);
  v.nodes().find(n=>n.type==='button'&&n.props['aria-label']==='Mover Data para cima').props.onClick();await v.flush();
  await v.click('Aplicar');assert.deepEqual(posts()[0].body.columns,['numero','cliente','data','total']);assert.equal(columns(),'numero,cliente,data,total');
  assert.equal(v.text().includes('Colunas customizadas'),false,'the drawer closes');
  await v.click('Listagem customizada');await v.change('list-column-all',false);assert.equal(v.button('Aplicar').disabled,true,'at least one column');
  await v.click('Restaurar listagem padrão');assert.deepEqual([posts()[1].body.expected_version,posts()[1].body.columns],[1,null]);assert.equal(columns(),'numero,cliente,total');
 }finally{v.unmount();}
 // Without the Sistema port (QA lists) the card names "o seu usuário".
 const g=createListPreferencesFixture(),w=await mountComponent('../../test/helpers/list-preferences-probe.tsx',{controller:g.controller,drawer:{}},{expandChildren:true});
 try{await w.click('Listagem customizada');assert.match(w.text(),/Essa configuração só aparecerá para o seu usuário\./);}finally{w.unmount();}
});

import{upce,upceExpand,code93,code93Checks,qrMatrix,barcode}from'../src/lib/barcodes.ts';
// An independent reading of a QR Code (ISO/IEC 18004 tables typed here, not taken from the encoder): function areas, format
// information, mask, zigzag, block de-interleaving, Reed-Solomon syndromes and the byte-mode text.
const QR_ALIGN={1:[],2:[6,18],3:[6,22],4:[6,26],5:[6,30],6:[6,34],7:[6,22,38],8:[6,24,42],9:[6,26,46],10:[6,28,50]};
const QR_TOTAL=[26,44,70,100,134,172,196,242,292,346],QR_M_BLOCKS=[1,1,1,2,2,4,4,4,5,5],QR_M_ECC=[10,16,26,18,24,16,18,22,22,26];
const FORMAT_M=['101010000010010','101000100100101','101111001111100','101101101001011','100010111111001','100000011001110','100111110010111','100101010100000'];
const EXP=[],LOG=[];for(let i=0,x=1;i<255;i++){EXP[i]=x;LOG[x]=i;x<<=1;if(x&0x100)x^=0x11d;}
const gmul=(a,b)=>a&&b?EXP[(LOG[a]+LOG[b])%255]:0;
function readQr(m){
 const size=m.length,ver=(size-17)/4;assert.ok(Number.isInteger(ver)&&ver>=1&&ver<=10,`size ${size}`);
 assert.ok(m.every(r=>r.length===size));
 const fn=Array.from({length:size},()=>Array(size).fill(false)),mark=(x,y)=>{if(x>=0&&y>=0&&x<size&&y<size)fn[y][x]=true;};
 for(let i=0;i<size;i++){mark(6,i);mark(i,6);}
 for(const[cx,cy]of[[3,3],[size-4,3],[3,size-4]])for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){mark(cx+dx,cy+dy);
  const x=cx+dx,y=cy+dy,d=Math.max(Math.abs(dx),Math.abs(dy));if(x>=0&&y>=0&&x<size&&y<size)assert.equal(m[y][x],d!==2&&d!==4,`finder ${x},${y}`);}
 for(let i=8;i<size-8;i++){assert.equal(m[6][i],i%2===0,'timing row');assert.equal(m[i][6],i%2===0,'timing column');}
 const al=QR_ALIGN[ver],lastAl=al.at(-1);for(const ax of al)for(const ay of al){if(ax===6&&ay===6||ax===6&&ay===lastAl||ax===lastAl&&ay===6)continue;for(let d=-2;d<=2;d++)for(let e=-2;e<=2;e++){mark(ax+d,ay+e);assert.equal(m[ay+e][ax+d],Math.max(Math.abs(d),Math.abs(e))!==1,'alignment');}}
 for(let i=0;i<=8;i++){mark(8,i);mark(i,8);}for(let i=0;i<8;i++){mark(size-1-i,8);mark(8,size-1-i);}assert.equal(m[size-8][8],true,'dark module');
 if(ver>=7)for(let i=0;i<18;i++){mark(size-11+i%3,Math.floor(i/3));mark(Math.floor(i/3),size-11+i%3);}
 const bit=(x,y)=>m[y][x]?1:0;let first=0,second=0;
 const firstAt=[[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
 firstAt.forEach(([x,y],i)=>{first|=bit(x,y)<<i;});for(let i=0;i<8;i++)second|=bit(size-1-i,8)<<i;for(let i=8;i<15;i++)second|=bit(8,size-15+i)<<i;
 assert.equal(first,second,'both copies of the format information');const mask=FORMAT_M.findIndex(s=>parseInt(s,2)===first);assert.ok(mask>=0,'level M and a valid mask');
 const masks=[(x,y)=>(x+y)%2===0,(x,y)=>y%2===0,(x,y)=>x%3===0,(x,y)=>(x+y)%3===0,(x,y)=>(Math.floor(y/2)+Math.floor(x/3))%2===0,(x,y)=>(x*y)%2+(x*y)%3===0,(x,y)=>((x*y)%2+(x*y)%3)%2===0,(x,y)=>((x+y)%2+(x*y)%3)%2===0];
 const bits=[];for(let right=size-1;right>=1;right-=2){if(right===6)right=5;for(let vert=0;vert<size;vert++)for(let j=0;j<2;j++){const x=right-j,y=((right+1)&2)===0?size-1-vert:vert;
  if(!fn[y][x])bits.push((m[y][x]!==masks[mask](x,y))?1:0);}}
 const total=QR_TOTAL[ver-1];assert.ok(bits.length>=total*8&&bits.length-total*8<8,`remainder bits ${bits.length} for ${total} codewords (version ${ver})`);
 const words=[];for(let i=0;i<total;i++)words.push(parseInt(bits.slice(i*8,i*8+8).join(''),2));
 const nb=QR_M_BLOCKS[ver-1],ecc=QR_M_ECC[ver-1],long=total%nb,shortData=Math.floor(total/nb)-ecc,blocks=Array.from({length:nb},(_,j)=>({data:[],ecc:[],len:shortData+(j>=nb-long?1:0)}));
 let k=0;for(let i=0;i<shortData+1;i++)for(const b of blocks)if(i<b.len)b.data.push(words[k++]);for(let i=0;i<ecc;i++)for(const b of blocks)b.ecc.push(words[k++]);assert.equal(k,total);
 for(const b of blocks){const c=[...b.data,...b.ecc];for(let i=0;i<ecc;i++){let s=0;for(const w of c)s=gmul(s,EXP[i])^w;assert.equal(s,0,`syndrome ${i}`);}}
 const data=blocks.flatMap(b=>b.data),dbits=data.flatMap(w=>[...w.toString(2).padStart(8,'0')].map(Number)),read=(at,n)=>parseInt(dbits.slice(at,at+n).join(''),2);
 assert.equal(read(0,4),4,'byte mode');const countBits=ver<10?8:16,count=read(4,countBits),bytes=[];for(let i=0;i<count;i++)bytes.push(read(4+countBits+i*8,8));
 let end=4+countBits+count*8;const term=Math.min(4,dbits.length-end);assert.equal(read(end,term)||0,0,'terminator');end+=term;end+=(8-end%8)%8;
 for(let i=0,pad=0xec;end+i*8<dbits.length;i++,pad^=0xec^0x11)assert.equal(read(end+i*8,8),pad,'pad codewords');
 return{ver,mask,text:new TextDecoder().decode(new Uint8Array(bytes))};
}

test('231 PRF-244 UPC-E, Code 93 and QR CODE are generated locally and read back',()=>{
 // UPC-E 0 425261 4 (UPC-A 04210000526 + check 4): start, six digits with the parity of the check (GLGGLL) and the end guard.
 assert.equal(upceExpand('0','425261'),'04210000526');const u=upce('04252614');assert.equal(u.length,51);assert.ok(u.startsWith('1010011101')&&u.endsWith('010101'));
 assert.equal(upce('425261'),u);assert.equal(upce('0425261'),u);assert.equal(upce('04252615'),null,'wrong check digit');assert.equal(upce('24252614'),null,'number system 0 or 1');
 assert.equal(upceExpand('0','123453'),'01230000045');assert.equal(upceExpand('0','123454'),'01234000005');assert.equal(upceExpand('1','123457'),'11234500007');
 // Code 93 "CODE 93": C = E (484 mod 47 = 14) and K = 0 (611 mod 47 = 0); (7 + 4) × 9 + 1 modules.
 assert.deepEqual(code93Checks([...'CODE 93'].map(c=>'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%'.indexOf(c))),[14,0]);
 const c=code93('CODE 93');assert.equal(c.length,100);assert.ok(c.startsWith('101011110')&&c.endsWith('1010111101'));assert.equal(code93('codigo'),null,'only capital letters');
 assert.equal(barcode('c93','CODE 93'),c);assert.equal(barcode('upce','04252614'),u);assert.equal(barcode('qr','x'),null,'QR CODE is 2D');
 for(const text of['7891234567895','Ação nº 5 — FAGOO','https://erp.example.test/produtos/12345?ref=etiqueta-sintetica-com-um-endereco-longo-para-a-versao-sete-ou-maior-do-qr',
  'X'.repeat(213)]){const r=readQr(qrMatrix(text));assert.equal(r.text,text);}
 assert.ok(readQr(qrMatrix('X'.repeat(150))).ver>=7,'version information present');assert.equal(qrMatrix('X'.repeat(214)),null);assert.equal(qrMatrix(''),null);
});

test('231 PRF-244 the label editor draws the QR CODE of the sample; EBCT and PDF417 stay disabled (DATA MATRIX since 283)',async()=>{
 const f=createReportsFixture(),v=await labels(f,'/preferencias/sistema/etiquetas-customizadas');try{
  const walk=x=>Array.isArray(x)?x.map(walk).find(Boolean):x&&typeof x==='object'?(x.type==='button'&&textOf(x)==='Clonar'?x:walk(x.props?.children)):undefined;
  walk(v.find(n=>n.type==='li'&&textOf(n).startsWith('Etiqueta de produto')).props.children).props.onClick();await v.flush();
  const before=v.nodes().filter(n=>n.type==='rect').length;await v.change('label-barcode','qr');
  const qr=v.nodes().find(n=>n.type==='g'&&String(n.props['aria-label']).startsWith('QR CODE '));assert.ok(qr,'QR CODE drawn');
  assert.ok(v.nodes().filter(n=>n.type==='rect').length>before,'more modules than the EAN-13 bars');
  for(const t of['UPC-E','C93','QR CODE'])assert.ok(v.nodes().some(n=>n.type==='option'&&textOf(n)===t&&!n.props.disabled),t);
  for(const t of['EBCT','PDF417'])assert.ok(v.nodes().some(n=>n.type==='option'&&n.props.value===t&&n.props.disabled),t);
 }finally{v.unmount();}
});
