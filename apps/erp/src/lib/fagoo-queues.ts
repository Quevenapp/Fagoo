export type QueueLine={id:string;name:string;prefix:string;priority:number;regulars_per_priority:number;active:boolean;version:number};
export type QueueTicket={id:string;queue_id:string;original_queue_id:string;display_number:string;number:number;status:string;priority:boolean;desk:string|null;reserved_desk?:string|null;issued_at:string;last_called_at:string|null;version:number;recalls:number;public_token?:string;phone?:string;ratings?:{stars:number;comment:string|null;received_at:string}[]};
export type QueueOrder={id:string;code:string;status:string;version:number};
export type QueueCampaign={id:string;title:string;media_url:string;media_type:'image'|'video';starts_at:string;expires_at:string;duration_seconds:number;priority:number;surfaces:string[];active:boolean;version:number};
export type QueueConfig={template:string;functions:string[];ratings_enabled:boolean;media_enabled:boolean;call_ttl_seconds:number;title:string;footer:string;version:number};
export type QueueDevice={id:string;name:string;capabilities:string[];active:boolean;panel?:{template?:string;volume?:number;muted?:boolean}};
export type QueueSnapshot={unit:{id:string;name:string;timezone:string};revision:number;server_time:string;config:QueueConfig;queues:QueueLine[];tickets:QueueTicket[];recent_calls:QueueTicket[];orders:QueueOrder[];campaigns:QueueCampaign[];managed_campaigns:QueueCampaign[];devices:QueueDevice[];effects:{id:string;kind:string;status:string;device_id:string;created_at:string}[]};
export type QueueResult={ok:boolean;command_id:string;revision?:number;result?:{ticket?:QueueTicket;print_job_id?:string;rating_invite_id?:string};error?:{code:string}};
export const QUEUE_TEMPLATES=[['sinal','Sinal'],['clinica','Clínica'],['terminal','Terminal'],['vitrine','Vitrine'],['sol','Sol']] as const;
export const QUEUE_STATUS:Record<string,string>={aguardando:'Aguardando',chamada:'Chamada',em_atendimento:'Em atendimento',concluida:'Concluída',ausente:'Ausente',cancelada:'Cancelada',recebido:'Recebido',em_preparo:'Em preparo',pronto:'Pronto',retirado:'Retirado',cancelado:'Cancelado',pending:'Pendente',claimed:'Em execução',done:'Confirmado',failed:'Falhou',uncertain:'Resultado incerto',expired:'Expirado'};
export const queueMessage=(code?:string)=>({queue_empty:'Nenhuma senha disponível para este guichê.',queue_version_conflict:'Este registro mudou. Confira os dados atualizados.',queue_invalid_transition:'A situação mudou e esta ação não está disponível.',queue_printer_not_available:'Selecione uma impressora ativa desta unidade.',queue_rating_unavailable:'A avaliação só pode ser solicitada durante ou após o atendimento.',queue_invalid_input:'Revise os campos informados.',queue_inactive:'Esta fila está desativada.',queue_reprint_confirmation:'Confirme a reimpressão para continuar.'}[code??'']??'A operação não foi realizada. Atualize a tela e confira os dados.');
export function parseQueueSnapshot(value:unknown,unitId:string):QueueSnapshot{
 const s=value as QueueSnapshot;
 if(!s||s.unit?.id!==unitId||!Number.isSafeInteger(s.revision)||s.revision<0||!Number.isFinite(Date.parse(s.server_time))||!s.config||![s.queues,s.tickets,s.recent_calls,s.orders,s.campaigns,s.devices,s.effects,s.managed_campaigns].every(Array.isArray))throw new Error('Resposta de filas inválida.');
 return s;
}
export function activeCampaigns(snapshot:QueueSnapshot,surface:string,now=Date.now()){
 const serverDelta=Date.parse(snapshot.server_time)-now;
 return snapshot.campaigns.filter(c=>c.active&&c.surfaces.includes(surface)&&Date.parse(c.starts_at)<=now+serverDelta&&Date.parse(c.expires_at)>now+serverDelta).sort((a,b)=>b.priority-a.priority||a.id.localeCompare(b.id));
}
// Guarda somente um identificador de confirmação. Nunca guarda ações para executar offline.
export const queueReceiptKey=(actor:string,unit:string)=>`fagoo.queue.receipt:${actor}:${unit}`;
export function readQueueReceipt(storage:Pick<Storage,'getItem'>,actor:string,unit:string){const id=storage.getItem(queueReceiptKey(actor,unit));return id&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)?id:null;}
