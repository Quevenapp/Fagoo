/** Local barcode encoders for Etiquetas customizadas (no library, no network): Code 128 (sets B and C), EAN-13, UPC-A,
 * MSI (mod 10), UPC-E and Code 93. Each returns the module string ("1" = bar, "0" = space) or null when the value cannot be
 * encoded. QR Code (2D) is `qrMatrix`: the dark modules by row, without the quiet zone; DATA MATRIX (2D, 202610200283) is
 * `dataMatrix`, the same way. */
export type BarcodeFormat='c128'|'ean13'|'upca'|'msi'|'upce'|'c93'|'qr'|'datamatrix';
// Code 128 symbol widths (bar, space, bar, space, bar, space), values 0..105, then Stop (106, seven widths).
const C128='212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112'.split(' ');
export const CODE128_PATTERNS:readonly string[]=C128;
const widths=(pattern:string)=>[...pattern].map((w,i)=>(i%2?'0':'1').repeat(Number(w))).join('');
/** Code 128: set C for an even run of digits, otherwise set B (printable ASCII 32..126). */
export function code128(value:string):string|null{
 if(!value||value.length>80||![...value].every(c=>c.charCodeAt(0)>=32&&c.charCodeAt(0)<=126))return null;
 const digits=/^\d+$/.test(value)&&value.length%2===0&&value.length>=4;
 const codes=digits?[105,...(value.match(/\d\d/g)??[]).map(Number)]:[104,...[...value].map(c=>c.charCodeAt(0)-32)];
 const check=codes.reduce((sum,code,i)=>sum+code*(i===0?1:i),0)%103;
 return [...codes,check,106].map(c=>widths(C128[c]!)).join('');
}
const L=['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const G=['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
const R=L.map(code=>[...code].map(b=>b==='1'?'0':'1').join(''));
const PARITY=['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];
export function ean13Check(twelve:string){const sum=[...twelve].reduce((s,d,i)=>s+Number(d)*(i%2?3:1),0);return String((10-sum%10)%10);}
/** EAN-13 from 12 digits (check added) or 13 digits (check verified). */
export function ean13(value:string):string|null{
 if(!/^\d{12,13}$/.test(value))return null;const code=value.length===12?value+ean13Check(value):value;if(code[12]!==ean13Check(code.slice(0,12)))return null;
 const parity=PARITY[Number(code[0])]!;let bits='101';
 for(let i=1;i<=6;i++)bits+=(parity[i-1]==='L'?L:G)[Number(code[i])]!;bits+='01010';for(let i=7;i<=12;i++)bits+=R[Number(code[i])]!;return bits+'101';
}
/** UPC-A: the EAN-13 bars with a leading 0 (11 digits plus check, or 12 with a valid check). */
export function upca(value:string):string|null{return /^\d{11,12}$/.test(value)?ean13(`0${value}`):null;}
/** MSI with the mod 10 check digit: start 110, each BCD bit 1 = 110 and 0 = 100, stop 1001. */
export function msi(value:string):string|null{
 if(!/^\d{1,30}$/.test(value))return null;
 const sum=[...value].reverse().reduce((s,d,i)=>{const n=Number(d)*(i%2===0?2:1);return s+(n>9?n-9:n);},0),full=value+String((10-sum%10)%10);
 return '110'+[...full].map(d=>Number(d).toString(2).padStart(4,'0').replace(/1/g,'X').replace(/0/g,'100').replace(/X/g,'110')).join('')+'1001';
}
// ---- UPC-E (number system 0 or 1): six digits, the number system and the check digit of the expanded UPC-A ----
const UPCE_PARITY=['GGGLLL','GGLGLL','GGLLGL','GGLLLG','GLGGLL','GLLGGL','GLLLGG','GLGLGL','GLGLLG','GLLGLG'];
/** UPC-A digits (11, without the check) of a UPC-E number system and six digits. */
export function upceExpand(system:string,six:string){
 const d=[...six],last=Number(d[5]);
 return system+(last<=2?`${d[0]}${d[1]}${d[5]}0000${d[2]}${d[3]}${d[4]}`:last===3?`${d[0]}${d[1]}${d[2]}00000${d[3]}${d[4]}`:last===4?`${d[0]}${d[1]}${d[2]}${d[3]}00000${d[4]}`:`${six.slice(0,5)}0000${d[5]}`);
}
/** UPC-E from 6 digits (number system 0), 7 (number system 0 or 1 and six digits) or 8 (with the check digit, verified). */
export function upce(value:string):string|null{
 if(!/^\d{6,8}$/.test(value))return null;
 const system=value.length===6?'0':value[0]!,six=value.length===6?value:value.slice(1,7);if(system!=='0'&&system!=='1')return null;
 const check=ean13Check(`0${upceExpand(system,six)}`);if(value.length===8&&value[7]!==check)return null;
 const parity=UPCE_PARITY[Number(check)]!;let bits='101';
 for(let i=0;i<6;i++){const even=(parity[i]==='G')===(system==='0');bits+=(even?G:L)[Number(six[i])]!;}
 return bits+'010101';
}
// ---- Code 93: 43 characters, start/stop, check characters C and K and the termination bar ----
const C93_CHARS='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';
const C93='131112 111213 111312 111411 121113 121212 121311 111114 131211 141111 211113 211212 211311 221112 221211 231111 112113 112212 112311 122112 132111 111123 111222 111321 121122 131121 212112 212211 211122 211221 221121 222111 112122 112221 122121 123111 121131 311112 311211 321111 112131 113121 211131 121221 312111 311121 122211'.split(' ');
const C93_START='111141';
export function code93Checks(values:number[]){
 const weigh=(list:number[],max:number)=>list.reduceRight((sum,v,i)=>sum+v*((list.length-1-i)%max+1),0)%47;
 const c=weigh(values,20);return[c,weigh([...values,c],15)] as const;
}
/** Code 93 of digits, capital letters, space and - . $ / + % (up to 40 characters), with the check characters C and K. */
export function code93(value:string):string|null{
 if(!value||value.length>40||![...value].every(ch=>C93_CHARS.includes(ch)))return null;
 const values=[...value].map(ch=>C93_CHARS.indexOf(ch)),[c,k]=code93Checks(values);
 return [C93_START,...[...values,c,k].map(v=>C93[v]!),C93_START].map(widths).join('')+'1';
}
// ---- QR Code (ISO/IEC 18004): byte mode (UTF-8), error correction level M, versions 1 to 10 (up to 213 bytes) ----
const QR_ECC=[10,16,26,18,24,16,18,22,22,26],QR_BLOCKS=[1,1,1,2,2,4,4,4,5,5];
const gfMul=(x:number,y:number)=>{let z=0;for(let i=7;i>=0;i--){z=(z<<1)^((z>>>7)*0x11d);z^=((y>>>i)&1)*x;}return z;};
const rsDivisor=(degree:number)=>{const r=new Array<number>(degree).fill(0);r[degree-1]=1;let root=1;
 for(let i=0;i<degree;i++){for(let j=0;j<degree;j++){r[j]=gfMul(r[j]!,root);if(j+1<degree)r[j]^=r[j+1]!;}root=gfMul(root,2);}return r;};
const rsRemainder=(data:readonly number[],divisor:readonly number[])=>{const r=divisor.map(()=>0);
 for(const b of data){const factor=b^r.shift()!;r.push(0);divisor.forEach((c,i)=>{r[i]^=gfMul(c,factor);});}return r;};
export const qrRawModules=(ver:number)=>{let r=(16*ver+128)*ver+64;if(ver>=2){const n=Math.floor(ver/7)+2;r-=(25*n-10)*n-55;if(ver>=7)r-=36;}return r;};
export const qrDataCodewords=(ver:number)=>Math.floor(qrRawModules(ver)/8)-QR_ECC[ver-1]!*QR_BLOCKS[ver-1]!;
export const qrBlocks=(ver:number)=>({count:QR_BLOCKS[ver-1]!,ecc:QR_ECC[ver-1]!});
const qrAlignment=(ver:number)=>{if(ver===1)return[] as number[];const n=Math.floor(ver/7)+2,step=Math.ceil((ver*4+4)/(n*2-2))*2,out=[6];
 for(let pos=ver*4+10;out.length<n;pos-=step)out.splice(1,0,pos);return out;};
const QR_MASKS:((x:number,y:number)=>boolean)[]=[(x,y)=>(x+y)%2===0,(_,y)=>y%2===0,x=>x%3===0,(x,y)=>(x+y)%3===0,(x,y)=>(Math.floor(x/3)+Math.floor(y/2))%2===0,
 (x,y)=>x*y%2+x*y%3===0,(x,y)=>(x*y%2+x*y%3)%2===0,(x,y)=>((x+y)%2+x*y%3)%2===0];
/** QR Code modules (true = dark) by row, or null when the text needs more than version 10 (213 bytes in UTF-8). */
export function qrMatrix(value:string):boolean[][]|null{
 if(!value)return null;
 const bytes=[...new TextEncoder().encode(value)];let ver=0;
 for(let v=1;v<=10&&!ver;v++)if(4+(v<10?8:16)+bytes.length*8<=qrDataCodewords(v)*8)ver=v;
 if(!ver)return null;
 const bits:number[]=[],put=(val:number,n:number)=>{for(let i=n-1;i>=0;i--)bits.push((val>>>i)&1);},capacity=qrDataCodewords(ver)*8;
 put(4,4);put(bytes.length,ver<10?8:16);for(const b of bytes)put(b,8);
 put(0,Math.min(4,capacity-bits.length));put(0,(8-bits.length%8)%8);for(let pad=0xec;bits.length<capacity;pad^=0xec^0x11)put(pad,8);
 const data:number[]=[];for(let i=0;i<bits.length;i+=8)data.push(bits.slice(i,i+8).reduce((a,b)=>a*2+b,0));
 const{count,ecc}=qrBlocks(ver),raw=Math.floor(qrRawModules(ver)/8),short=count-raw%count,shortLen=Math.floor(raw/count),divisor=rsDivisor(ecc),blocks:number[][]=[];
 for(let i=0,k=0;i<count;i++){const dat=data.slice(k,k+shortLen-ecc+(i<short?0:1));k+=dat.length;const rem=rsRemainder(dat,divisor);if(i<short)dat.push(0);blocks.push([...dat,...rem]);}
 const codewords:number[]=[];for(let i=0;i<blocks[0]!.length;i++)blocks.forEach((b,j)=>{if(i!==shortLen-ecc||j>=short)codewords.push(b[i]!);});
 const size=ver*4+17,m=Array.from({length:size},()=>new Array<boolean>(size).fill(false)),fn=Array.from({length:size},()=>new Array<boolean>(size).fill(false));
 const set=(x:number,y:number,dark:boolean)=>{m[y]![x]=dark;fn[y]![x]=true;};
 for(let i=0;i<size;i++){set(6,i,i%2===0);set(i,6,i%2===0);}
 for(const[cx,cy]of[[3,3],[size-4,3],[3,size-4]] as const)for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){const x=cx+dx,y=cy+dy;
  if(x>=0&&x<size&&y>=0&&y<size){const d=Math.max(Math.abs(dx),Math.abs(dy));set(x,y,d!==2&&d!==4);}}
 const align=qrAlignment(ver),last=align.length-1;
 align.forEach((ax,i)=>align.forEach((ay,j)=>{if(i===0&&j===0||i===0&&j===last||i===last&&j===0)return;
  for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)set(ax+dx,ay+dy,Math.max(Math.abs(dx),Math.abs(dy))!==1);}));
 // Format information: level M (00) and the mask, BCH(15,5) and the fixed XOR mask; then the dark module.
 const format=(mask:number)=>{let r=mask;for(let i=0;i<10;i++)r=(r<<1)^((r>>>9)*0x537);const b=((mask<<10)|r)^0x5412,bit=(i:number)=>((b>>>i)&1)!==0;
  for(let i=0;i<=5;i++)set(8,i,bit(i));set(8,7,bit(6));set(8,8,bit(7));set(7,8,bit(8));for(let i=9;i<15;i++)set(14-i,8,bit(i));
  for(let i=0;i<8;i++)set(size-1-i,8,bit(i));for(let i=8;i<15;i++)set(8,size-15+i,bit(i));set(8,size-8,true);};
 format(0);
 if(ver>=7){let r=ver;for(let i=0;i<12;i++)r=(r<<1)^((r>>>11)*0x1f25);const b=(ver<<12)|r;
  for(let i=0;i<18;i++){const dark=((b>>>i)&1)!==0,a=size-11+i%3,c=Math.floor(i/3);set(a,c,dark);set(c,a,dark);}}
 let n=0;for(let right=size-1;right>=1;right-=2){if(right===6)right=5;
  for(let vert=0;vert<size;vert++)for(let j=0;j<2;j++){const x=right-j,y=((right+1)&2)===0?size-1-vert:vert;
   if(!fn[y]![x]&&n<codewords.length*8){m[y]![x]=((codewords[n>>>3]!>>>(7-(n&7)))&1)!==0;n++;}}}
 const apply=(mask:number)=>{const f=QR_MASKS[mask]!;for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(!fn[y]![x]&&f(x,y))m[y]![x]=!m[y]![x];};
 const penalty=()=>{let p=0;
  const lines=(at:(a:number,b:number)=>boolean)=>{for(let a=0;a<size;a++){let color=false,run=0;const hist=[0,0,0,0,0,0,0];
   const add=(len:number)=>{if(hist[0]===0)len+=size;hist.pop();hist.unshift(len);};
   const finders=()=>{const k=hist[1]!,core=k>0&&hist[2]===k&&hist[3]===k*3&&hist[4]===k&&hist[5]===k;return(core&&hist[0]!>=k*4&&hist[6]!>=k?1:0)+(core&&hist[6]!>=k*4&&hist[0]!>=k?1:0);};
   for(let b=0;b<size;b++){if(at(a,b)===color){run++;if(run===5)p+=3;else if(run>5)p++;}else{add(run);if(!color)p+=finders()*40;color=at(a,b);run=1;}}
   if(color){add(run);run=0;}add(run+size);p+=finders()*40;}};
  lines((y,x)=>m[y]![x]!);lines((x,y)=>m[y]![x]!);
  for(let y=0;y<size-1;y++)for(let x=0;x<size-1;x++){const c=m[y]![x];if(c===m[y]![x+1]&&c===m[y+1]![x]&&c===m[y+1]![x+1])p+=3;}
  const dark=m.reduce((sum,row)=>sum+row.filter(Boolean).length,0),total=size*size;return p+(Math.ceil(Math.abs(dark*20-total*10)/total)-1)*10;};
 let best=0,min=Infinity;for(let mask=0;mask<8;mask++){apply(mask);format(mask);const score=penalty();if(score<min){min=score;best=mask;}apply(mask);}
 apply(best);format(best);return m;
}
// ---- DATA MATRIX (ISO/IEC 16022, ECC 200): ASCII encodation (digit pairs, Upper Shift for Latin-1), square symbols 10×10 to 48×48 ----
// One Reed-Solomon block in every size used here (GF(256), x^8+x^5+x^3+x^2+1, generator roots α^1..α^n); data regions of 8..22 modules,
// 2×2 regions from 32×32 on. Up to 174 data codewords (348 digits or 174 Latin-1 characters).
const DM_SIZES:readonly{size:number;region:number;regions:number;data:number;ecc:number}[]=[[10,8,1,3,5],[12,10,1,5,7],[14,12,1,8,10],[16,14,1,12,12],[18,16,1,18,14],[20,18,1,22,18],
 [22,20,1,30,20],[24,22,1,36,24],[26,24,1,44,28],[32,14,2,62,36],[36,16,2,86,42],[40,18,2,114,48],[44,20,2,144,56],[48,22,2,174,68]].map(([size,region,regions,data,ecc])=>({size:size!,region:region!,regions:regions!,data:data!,ecc:ecc!}));
const DM_EXP:number[]=[],DM_LOG:number[]=new Array<number>(256).fill(0);
{let x=1;for(let i=0;i<255;i++){DM_EXP[i]=x;DM_LOG[x]=i;x<<=1;if(x&0x100)x^=0x12d;}}
const dmMul=(a:number,b:number)=>a&&b?DM_EXP[(DM_LOG[a]!+DM_LOG[b]!)%255]!:0;
/** Error correction codewords of one block: the remainder of data·x^n by the generator (roots α^1..α^n). */
export function dataMatrixEcc(data:readonly number[],n:number):number[]{
 let g=[1];for(let i=1;i<=n;i++){const next=new Array<number>(g.length+1).fill(0);g.forEach((c,j)=>{next[j]^=c;next[j+1]^=dmMul(c,DM_EXP[i]!);});g=next;}
 const rem=new Array<number>(n).fill(0);
 for(const d of data){const factor=d^rem.shift()!;rem.push(0);for(let j=0;j<n;j++)rem[j]^=dmMul(g[j+1]!,factor);}
 return rem;
}
/** ASCII encodation: two digits per codeword (130+nn), ASCII 0..127 as value+1, Latin-1 128..255 with Upper Shift (235). */
export function dataMatrixCodewords(value:string):number[]|null{
 const chars=[...value].map(ch=>ch.codePointAt(0)!);if(!chars.length||chars.some(c=>c>255))return null;
 const out:number[]=[];
 for(let i=0;i<chars.length;i++){const c=chars[i]!,d=chars[i+1];
  if(c>=48&&c<=57&&d!==undefined&&d>=48&&d<=57){out.push(130+(c-48)*10+(d-48));i++;}
  else if(c<128)out.push(c+1);else out.push(235,c-127);}
 return out;
}
/** The placement of the codewords in the mapping matrix (ISO/IEC 16022 Annex F): for each module, codeword*10+bit (bit 1 = most
 * significant), 1 for the fixed dark corner modules, 0 for the light ones. */
export function dataMatrixPlacement(nrow:number,ncol:number):number[]{
 const a=new Array<number>(nrow*ncol).fill(0);
 const module=(row:number,col:number,chr:number,bit:number)=>{if(row<0){row+=nrow;col+=4-((nrow+4)%8);}if(col<0){col+=ncol;row+=4-((ncol+4)%8);}a[row*ncol+col]=10*chr+bit;};
 const utah=(row:number,col:number,chr:number)=>{module(row-2,col-2,chr,1);module(row-2,col-1,chr,2);module(row-1,col-2,chr,3);module(row-1,col-1,chr,4);module(row-1,col,chr,5);
  module(row,col-2,chr,6);module(row,col-1,chr,7);module(row,col,chr,8);};
 const corner=(chr:number,cells:readonly(readonly[number,number])[])=>cells.forEach(([r,c],i)=>module(r,c,chr,i+1));
 let chr=1,row=4,col=0;
 do{
  if(row===nrow&&col===0)corner(chr++,[[nrow-1,0],[nrow-1,1],[nrow-1,2],[0,ncol-2],[0,ncol-1],[1,ncol-1],[2,ncol-1],[3,ncol-1]]);
  if(row===nrow-2&&col===0&&ncol%4)corner(chr++,[[nrow-3,0],[nrow-2,0],[nrow-1,0],[0,ncol-4],[0,ncol-3],[0,ncol-2],[0,ncol-1],[1,ncol-1]]);
  if(row===nrow-2&&col===0&&ncol%8===4)corner(chr++,[[nrow-3,0],[nrow-2,0],[nrow-1,0],[0,ncol-2],[0,ncol-1],[1,ncol-1],[2,ncol-1],[3,ncol-1]]);
  if(row===nrow+4&&col===2&&!(ncol%8))corner(chr++,[[nrow-1,0],[nrow-1,ncol-1],[0,ncol-3],[0,ncol-2],[0,ncol-1],[1,ncol-3],[1,ncol-2],[1,ncol-1]]);
  do{if(row<nrow&&col>=0&&!a[row*ncol+col])utah(row,col,chr++);row-=2;col+=2;}while(row>=0&&col<ncol);
  row+=1;col+=3;
  do{if(row>=0&&col<ncol&&!a[row*ncol+col])utah(row,col,chr++);row+=2;col-=2;}while(row<nrow&&col>=0);
  row+=3;col+=1;
 }while(row<nrow||col<ncol);
 if(!a[nrow*ncol-1]){a[nrow*ncol-1]=1;a[nrow*ncol-ncol-2]=1;}
 return a;
}
/** DATA MATRIX modules (true = dark) by row, with the finder (solid left and bottom, dotted top and right) of each data region and
 * without the quiet zone; null when the text needs more than 48×48 or has a character above Latin-1. */
export function dataMatrix(value:string):boolean[][]|null{
 const data=dataMatrixCodewords(value);if(!data)return null;
 const s=DM_SIZES.find(x=>x.data>=data.length);if(!s)return null;
 const words=[...data];
 if(words.length<s.data)words.push(129);
 while(words.length<s.data){const p=words.length+1;let pad=129+((149*p)%253)+1;if(pad>254)pad-=254;words.push(pad);}
 const all=[...words,...dataMatrixEcc(words,s.ecc)],n=s.region*s.regions,place=dataMatrixPlacement(n,n);
 const dark=(i:number)=>{const v=place[i]!;if(v===1)return true;if(v<10)return false;const cw=all[Math.floor(v/10)-1]!,bit=v%10;return((cw>>(8-bit))&1)===1;};
 const m=Array.from({length:s.size},()=>new Array<boolean>(s.size).fill(false)),side=s.region+2;
 for(let ry=0;ry<s.regions;ry++)for(let rx=0;rx<s.regions;rx++){const oy=ry*side,ox=rx*side;
  for(let k=0;k<side;k++){m[oy+k]![ox]=true;m[oy+side-1]![ox+k]=true;m[oy]![ox+k]=k%2===0;m[oy+k]![ox+side-1]=k%2===1||k===side-1;}
  for(let i=0;i<s.region;i++)for(let j=0;j<s.region;j++)m[oy+1+i]![ox+1+j]=dark((ry*s.region+i)*n+rx*s.region+j);}
 return m;
}
export function barcode(format:BarcodeFormat,value:string|null):string|null{
 if(!value)return null;
 switch(format){case'c128':return code128(value);case'ean13':return ean13(value);case'upca':return upca(value);case'msi':return msi(value);case'upce':return upce(value);case'c93':return code93(value);default:return null;}
}
/** Runs of bars as [start, width] for an SVG drawing. */
export function barRuns(bits:string):[number,number][]{const out:[number,number][]=[];let i=0;while(i<bits.length){if(bits[i]==='1'){const s=i;while(bits[i]==='1')i++;out.push([s,i-s]);}else i++;}return out;}
