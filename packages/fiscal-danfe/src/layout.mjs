// Conservative text geometry for the explicit Times New Roman header profile.
// Figures use lexical strings. These measurements never change fiscal values.
const mmPerPoint=25.4/72;
function em(char){
 if(char===' ')return .4;
 if(char==='·')return .5;
 const base=char.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
 if(base!==char&&/^[A-Za-z]$/.test(base))return em(base)+.1;
 if(/[MW@%&]/.test(char))return 1.1;
 if(/[A-Z]/.test(char))return .85;
 if(/[mw]/.test(char))return .95;
 if(/[0-9]/.test(char))return .65;
 if(char.codePointAt(0)>127)return 2.5;
 return .7;
}
export function headerLines(value,widthMm,fontPt){
 const capacity=widthMm/(fontPt*mmPerPoint),lines=[];
 for(const paragraph of String(value??'-').replace(/\r\n?|[\u2028\u2029]/g,'\n').split('\n')){
  let line='',used=0;
  for(const word of paragraph.trim().split(/\s+/)){
   if(!word)continue;
   const length=Array.from(word).reduce((sum,c)=>sum+em(c),0);
   if(line&&used+.4+length>capacity){lines.push(line);line='';used=0;}
   if(line){line+=' ';used+=.4;}
   for(const char of word){const size=em(char);if(line&&used+size>capacity){lines.push(line);line='';used=0;}line+=char;used+=size;}
  }
  lines.push(line);
 }
 return lines;
}
const WIDTHS={row1:[200],row2:[100,100],row3:[100,50,50],row5:[40,40,40,40,40],row6:Array(6).fill(200/6)};
export function fieldLayout(names,values,kind){
 const widths=WIDTHS[kind];
 const cells=names.map((name,i)=>({caption:headerLines(name.toUpperCase(),widths[i]-2.4,6),value:headerLines(values[i],widths[i]-2.4,10)}));
 return {cells,height:Math.max(8,...cells.map(c=>2.4+c.caption.length*2.8+c.value.length*4.2))};
}
export function issuerLayout(data){
 const name=headerLines(data.name,75.4,12),address=headerLines(data.address,75.4,8);
 return {name,address,height:4+name.length*5.2+1+address.length*3.4};
}
