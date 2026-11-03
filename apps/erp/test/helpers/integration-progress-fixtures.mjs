import {INTEGRATION_LABELS,PROGRESS_VARIANTS,EXTRA_INTEGRATION_LABELS,EXTRA_PROGRESS_VARIANTS} from '../../src/lib/integration-progress-model.ts';
export const progressStamp='2026-10-16T12:00:00Z';
const entities=labels=>Object.keys(labels).map(entity=>({entity,records:0,oldest_observation:null,newest_observation:null}));
const resources=variants=>Object.entries(variants).map(([resource,[entity,windowed]])=>({resource,entity,windowed,checkpoint_present:false,state_updated_at:null,recent_completed_local:null,history_completed_local:null,sweep_completed_local:null,recent_open:false,history_open:false,sweep_open:false}));
export function progressFixture(records=0){
 const rows=entities(INTEGRATION_LABELS),contact=rows.find(x=>x.entity==='contacts');contact.records=records;if(records)contact.oldest_observation=contact.newest_observation=progressStamp;
 return{data_mode:'integration_progress_readonly',as_of:progressStamp,role:'admin',coverage_certified:false,erp_mutations:false,runtime_configuration_known:false,entities:rows,resources:resources(PROGRESS_VARIANTS),last_run:null,last_xml_run:null,last_finance_run:null,
  xml:{known_origins:0,eligible_origins:0,without_valid_key:0,with_preserved_revision:0,without_preserved_revision:0,never_attempted:0,retry_origins:0,blocked_origins:0,backing_off:0,preserved_objects:0,preserved_revisions:0,last_success_at:null,validation:'structural_only',authorization_verified:false},
  finance_refresh:{entities:['payables','receivables'].map(entity=>({entity,known_open_partial:0,observed_over_hour_ago:0,unavailable_balance:0,backing_off:0,oldest_observation:null,last_success_at:null,retry_after:null})),reference_limits:{max_ids:8,max_seconds:40,max_attempts:24,shared_requests:120,observation_age_seconds:3600}}};
}
export function progressExtraFixture({requested=25,returned=17}={}){
 const extra={profile:'origin-extra-progress-v1',coverage_certified:false,entities:entities(EXTRA_INTEGRATION_LABELS),resources:resources(EXTRA_PROGRESS_VARIANTS),stock_last_observation:{requested,returned,unavailable:requested-returned,observed_at:progressStamp,coverage_complete:false}};
 const stock=extra.resources.find(x=>x.resource==='stock_balances');stock.checkpoint_present=true;stock.state_updated_at=progressStamp;stock.sweep_open=true;
 return{...progressFixture(),extra_resources:extra};
}
