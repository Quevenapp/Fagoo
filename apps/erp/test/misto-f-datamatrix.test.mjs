import test from'node:test';import assert from'node:assert/strict';
import{mountComponent}from'./helpers/component-recovery-harness.mjs';
import{createReportsFixture}from'../src/qa/reports-fixture.ts';
import{dataMatrix,dataMatrixCodewords,dataMatrixEcc,barcode}from'../src/lib/barcodes.ts';

// 283 PRF-244: DATA MATRIX (ECC 200) generated locally, read back by an independent reader written here from ISO/IEC 16022 (symbol
// table, finder, Annex F placement, Reed-Solomon syndromes over GF(256) with 0x12D, ASCII decodation). Synthetic texts only.
const textOf=x=>Array.isArray(x)?x.map(textOf).join(''):x&&typeof x==='object'?textOf(x.props?.children):x===null||x===undefined||typeof x==='boolean'?'':String(x);
// Symbol size → [data region size, regions per side, data codewords, error correction codewords] (ISO/IEC 16022 Table 7, one block).
const TABLE={10:[8,1,3,5],12:[10,1,5,7],14:[12,1,8,10],16:[14,1,12,12],18:[16,1,18,14],20:[18,1,22,18],22:[20,1,30,20],24:[22,1,36,24],26:[24,1,44,28],
 32:[14,2,62,36],36:[16,2,86,42],40:[18,2,114,48],44:[20,2,144,56],48:[22,2,174,68]};
// GF(256) by shift-and-add (no tables), reduced by x^8+x^5+x^3+x^2+1.
const mul=(a,b)=>{let r=0;while(b){if(b&1)r^=a;b>>=1;a<<=1;if(a&0x100)a^=0x12d;}return r;};
const pow=(a,e)=>{let r=1;for(let i=0;i<e;i++)r=mul(r,a);return r;};
// Annex F, as a list of the positions (row, column) of the 8 bits of each codeword in order.
function positions(nrow,ncol){
 const taken=new Set(),order=[];
 const at=(row,col)=>{if(row<0){row+=nrow;col+=4-((nrow+4)%8);}if(col<0){col+=ncol;row+=4-((ncol+4)%8);}return[row,col];};
 const put=cells=>{const word=cells.map(([r,c])=>at(r,c));word.forEach(([r,c])=>taken.add(r*ncol+c));order.push(word);};
 const utah=(r,c)=>put([[r-2,c-2],[r-2,c-1],[r-1,c-2],[r-1,c-1],[r-1,c],[r,c-2],[r,c-1],[r,c]]);
 let row=4,col=0;
 do{
  if(row===nrow&&col===0)put([[nrow-1,0],[nrow-1,1],[nrow-1,2],[0,ncol-2],[0,ncol-1],[1,ncol-1],[2,ncol-1],[3,ncol-1]]);
  if(row===nrow-2&&col===0&&ncol%4!==0)put([[nrow-3,0],[nrow-2,0],[nrow-1,0],[0,ncol-4],[0,ncol-3],[0,ncol-2],[0,ncol-1],[1,ncol-1]]);
  if(row===nrow-2&&col===0&&ncol%8===4)put([[nrow-3,0],[nrow-2,0],[nrow-1,0],[0,ncol-2],[0,ncol-1],[1,ncol-1],[2,ncol-1],[3,ncol-1]]);
  if(row===nrow+4&&col===2&&ncol%8===0)put([[nrow-1,0],[nrow-1,ncol-1],[0,ncol-3],[0,ncol-2],[0,ncol-1],[1,ncol-3],[1,ncol-2],[1,ncol-1]]);
  for(;row>=0&&col<ncol;row-=2,col+=2)if(row<nrow&&col>=0&&!taken.has(row*ncol+col))utah(row,col);
  row+=1;col+=3;
  for(;row<nrow&&col>=0;row+=2,col-=2)if(row>=0&&col<ncol&&!taken.has(row*ncol+col))utah(row,col);
  row+=3;col+=1;
 }while(row<nrow||col<ncol);
 return{order,taken};
}
function readDataMatrix(m){
 const size=m.length;assert.ok(m.every(r=>r.length===size),'square');const t=TABLE[size];assert.ok(t,`symbol size ${size}`);
 const[region,regions,dataWords,eccWords]=t,side=region+2,n=region*regions;
 const map=Array.from({length:n},()=>new Array(n).fill(false));
 for(let ry=0;ry<regions;ry++)for(let rx=0;rx<regions;rx++){const oy=ry*side,ox=rx*side;
  for(let k=0;k<side;k++){
   assert.equal(m[oy+k][ox],true,'solid left edge');assert.equal(m[oy+side-1][ox+k],true,'solid bottom edge');
   assert.equal(m[oy][ox+k],k%2===0,'dotted top edge');if(k<side-1)assert.equal(m[oy+k][ox+side-1],k%2===1,'dotted right edge');}
  for(let i=0;i<region;i++)for(let j=0;j<region;j++)map[ry*region+i][rx*region+j]=m[oy+1+i][ox+1+j];}
 const{order,taken}=positions(n,n);
 assert.equal(order.length,dataWords+eccWords,'codeword count of the symbol');
 // Modules left untouched by the placement: the fixed corner (dark at the bottom-right and the one up-left of it, light otherwise).
 for(let r=0;r<n;r++)for(let c=0;c<n;c++)if(!taken.has(r*n+c))assert.equal(map[r][c],(r===n-1&&c===n-1)||(r===n-2&&c===n-2),`fixed module ${r},${c}`);
 const words=order.map(cells=>cells.reduce((v,[r,c])=>v*2+(map[r][c]?1:0),0));
 // Every syndrome S_i = c(α^i), i = 1..n, is zero for a codeword of the generator with roots α^1..α^n.
 for(let i=1;i<=eccWords;i++){const x=pow(2,i);let s=0;for(const w of words)s=mul(s,x)^w;assert.equal(s,0,`syndrome ${i}`);}
 const data=words.slice(0,dataWords),out=[];let upper=false;
 for(let i=0;i<data.length;i++){const v=data[i];
  if(v===129){for(let p=i+1;p<data.length;p++){let pad=129+((149*(p+1))%253)+1;if(pad>254)pad-=254;assert.equal(data[p],pad,'randomized pad');}break;}
  if(upper){out.push(v+127);upper=false;continue;}
  if(v>=1&&v<=128)out.push(v-1);else if(v>=130&&v<=229){const d=String(v-130).padStart(2,'0');out.push(d.charCodeAt(0),d.charCodeAt(1));}else if(v===235)upper=true;else assert.fail(`codeword ${v}`);}
 return{size,text:String.fromCharCode(...out),words};
}

test('283 PRF-244 DATA MATRIX: the ISO example 123456 and texts of every size are read back by an independent reader',()=>{
 // ISO/IEC 16022: "123456" is the data codewords 142 164 186 and the error correction 114 25 5 88 102 in a 10×10 symbol.
 assert.deepEqual(dataMatrixCodewords('123456'),[142,164,186]);assert.deepEqual(dataMatrixEcc([142,164,186],5),[114,25,5,88,102]);
 const iso=readDataMatrix(dataMatrix('123456'));assert.deepEqual([iso.size,iso.text,iso.words],[10,'123456',[142,164,186,114,25,5,88,102]]);
 for(const[text,size]of[['7891234567895',14],['SKU-ABC-01',16],['Preço à vista R$ 10,00',20],['P'.repeat(60),32],['Produto sintético com descrição longa '.repeat(3),44],['1'.repeat(348),48],['A'.repeat(174),48]]){
  const r=readDataMatrix(dataMatrix(text));assert.equal(r.text,text);assert.equal(r.size,size,text.slice(0,20));}
 assert.equal(dataMatrix('1'.repeat(349)),null,'beyond 48×48');assert.equal(dataMatrix('A'.repeat(175)),null);assert.equal(dataMatrix(''),null);assert.equal(dataMatrix('Preço €'),null,'above Latin-1');
 assert.equal(barcode('datamatrix','123456'),null,'DATA MATRIX is 2D');
});

test('283 PRF-244 the label editor offers and draws DATA MATRIX; EBCT and PDF417 stay disabled',async()=>{
 const f=createReportsFixture(),v=await mountComponent('RealLabels.tsx',{controller:f.controller},{location:'/preferencias/sistema/etiquetas-customizadas',expandChildren:['OriginListHeader','LabelSvg','Modal']});try{
  const walk=x=>Array.isArray(x)?x.map(walk).find(Boolean):x&&typeof x==='object'?(x.type==='button'&&textOf(x)==='Clonar'?x:walk(x.props?.children)):undefined;
  walk(v.find(n=>n.type==='li'&&textOf(n).startsWith('Etiqueta de produto')).props.children).props.onClick();await v.flush();
  assert.ok(v.nodes().some(n=>n.type==='option'&&textOf(n)==='DATA MATRIX'&&!n.props.disabled));
  for(const t of['EBCT','PDF417'])assert.ok(v.nodes().some(n=>n.type==='option'&&n.props.value===t&&n.props.disabled),t);
  await v.change('label-barcode','datamatrix');
  const drawn=v.nodes().find(n=>n.type==='g'&&String(n.props['aria-label']).startsWith('DATA MATRIX '));assert.ok(drawn,'DATA MATRIX drawn');
 }finally{v.unmount();}
});
