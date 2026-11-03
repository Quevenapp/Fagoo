// Synthetic 101 freshness envelopes for route and UI tests. No real data.
import{FRESHNESS_ENTITIES,FRESHNESS_LEVELS,freshnessStatus}from'../../src/integration-progress.mjs';
export const freshnessStamp='2026-10-19T13:00:00.000Z';
const iso=value=>new Date(value).toISOString();
const emptyLane=([resource,lane])=>({resource,lane,checkpoint_present:false,open:false,completed_started_at:null,completed_finished_at:null});
export function freshnessResponse({asOf=freshnessStamp}={}){
 return{profile:'origin-sync-freshness-v1',data_mode:'origin_sync_freshness_readonly',as_of:asOf,role:'admin',time_zone:'America/Sao_Paulo',coverage_certified:false,erp_mutations:false,
  levels:Object.entries(FRESHNESS_LEVELS).map(([level,target_seconds])=>({level,target_seconds,stale_after_seconds:3*target_seconds})),
  collector:{oauth_connected:false,oauth_expires_at:null,last_run_status:null,last_run_started_at:null,last_run_finished_at:null,last_run_error_count:null,last_error_code:null,last_error_resource:null},
  entities:FRESHNESS_ENTITIES.map(([entity,level,lanes])=>({entity,level,target_seconds:FRESHNESS_LEVELS[level],records:0,last_changed_at:null,last_seen_at:null,oldest_seen_at:null,
   lanes_total:lanes.length,lanes_measured:0,freshness_at:null,age_seconds:null,pass_finished_at:null,pass_resource:null,pass_lane:null,status:'stale',lanes:lanes.map(emptyLane)}))};
}
// Completes every lane of one entity. The last lane holds the oldest start, so the limiting
// pass is never simply the first or the most recent one.
export function measureEntity(value,entity,{ageSeconds,records=0,seenSecondsAgo=30}={}){
 const row=value.entities.find(x=>x.entity===entity),now=Date.parse(value.as_of),oldest=now-ageSeconds*1000;
 row.lanes.forEach((lane,i)=>{const start=i===row.lanes.length-1?oldest:Math.min(oldest+60000,now);Object.assign(lane,{checkpoint_present:true,completed_started_at:iso(start),completed_finished_at:iso(Math.min(start+30000,now))});});
 const limit=row.lanes.at(-1);
 Object.assign(row,{lanes_measured:row.lanes.length,freshness_at:limit.completed_started_at,age_seconds:ageSeconds,pass_finished_at:limit.completed_finished_at,
  pass_resource:limit.resource,pass_lane:limit.lane,status:freshnessStatus(ageSeconds,row.target_seconds)});
 if(records)Object.assign(row,{records,last_changed_at:iso(now-3600000),last_seen_at:iso(now-seenSecondsAgo*1000),oldest_seen_at:iso(now-86400000)});
 return value;
}
