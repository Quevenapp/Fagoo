import {dateField,encodeRecords,makeRecord,numeric,readRecords,requireCnab} from './primitives.mjs';
function field(row,from,to,value){requireCnab(value.length===to-from+1,'CNAB_FIELD_SIZE_INVALID');return row.slice(0,from-1)+value+row.slice(to);}
const sequence=(row,n)=>field(row,395,400,numeric(String(n),6));

export function encodeObservedRecords(base,reviews){
  const rows=readRecords(base.bytes),records=[rows[0]];
  for(let i=0;i<reviews.length;i++){
    const e=reviews[i].encoding;
    let detail=field(rows[i+1],157,160,'0000');
    detail=field(detail,161,173,numeric(e.dailyInterestCents,13));
    detail=field(detail,386,391,dateField(e.interestDateField));
    records.push(sequence(detail,records.length+1));
    const d=e.penaltyDateField;
    records.push(makeRecord([[1,1,'2'],[2,2,'2'],[3,10,d.slice(8,10)+d.slice(5,7)+d.slice(0,4)],
      [11,23,'0000000000200'],[395,400,numeric(String(records.length+1),6)]]));
  }
  records.push(sequence(rows.at(-1),records.length+1));
  return encodeRecords(records);
}
