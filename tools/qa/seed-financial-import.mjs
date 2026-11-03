/** Local embedded QA only. No network, bank operation or native financial title. */
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';

const marker = 'qa_financial_import_039';
const contactSource = '9399000001';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Requires migration039 and an already-created synthetic admin.
 * All six sources and their detail evidence commit together. Calling twice
 * fails instead of resetting an imported title or replacing its evidence.
 */
export async function seedFinancialImport(db, { uid } = {}) {
  if (!(db instanceof PGlite)) throw new TypeError('Synthetic financial import seed requires embedded PGlite');
  if (typeof uid !== 'string' || !uuid.test(uid)) throw new TypeError('Synthetic financial import seed requires a local admin UUID');
  await db.exec('begin');
  try {
    if (!(await db.query("select to_regprocedure('public.erp_origin_financial_import_preview(uuid,text,jsonb,boolean)') is not null ready")).rows[0].ready) throw new Error('Synthetic financial import seed requires migration039');
    if (!(await db.query("select exists(select 1 from erp_access.membership where user_id=$1 and active and role='admin') ready", [uid])).rows[0].ready) throw new Error('Synthetic financial import seed requires an active local admin');
    if ((await db.query('select exists(select 1 from origin_sync.resource_state where resource=$1) present', [marker])).rows[0].present) throw new Error('Synthetic financial import fixture already exists');
    await db.query('insert into origin_sync.resource_state(resource) values($1)', [marker]);
    const dates = (await db.query("select (clock_timestamp() at time zone 'America/Sao_Paulo')::date::text issued,((clock_timestamp() at time zone 'America/Sao_Paulo')::date+30)::text due")).rows[0];
    const stage = async (entity, id, payload, minutes = 2) => (await db.query(`insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash,last_seen_at)
      values($1,$2,$3,$4::jsonb,encode(sha256(convert_to(jsonb_build_object('payload',$4::jsonb,'document_links','[]'::jsonb)::text,'UTF8')),'hex'),clock_timestamp()-make_interval(mins=>$5::int))
      returning source_id,version_hash source_hash,version::text source_version,last_seen_at`, [entity, marker, id, JSON.stringify(payload), minutes])).rows[0];
    const contactRow = await stage('contacts', contactSource, { id: contactSource, nome: 'Contato inteiramente fictício QA039', codigo: 'QA039-CONTATO', tipo: 'J', situacao: 'A', synthetic_qa: true });
    const imported = (await db.query("select public.erp_catalog_import_origin($1,'contacts',$2::jsonb,$3,false) result", [uid, JSON.stringify([{ source_id: contactSource, source_hash: contactRow.source_hash }]), randomUUID()])).rows[0].result;
    const nativeContact = imported.items?.[0]?.record_id;
    if (typeof nativeContact !== 'string' || !uuid.test(nativeContact)) throw new Error('Synthetic financial import contact was not created');
    const definitions = [
      { id: '9390000001', entity: 'receivables', label: 'Recebível elegível A', amount: 25.7, balance: 25.7, status: 1, minutes: 2, contact: contactSource, expected: 'eligible' },
      { id: '9390000002', entity: 'receivables', label: 'Recebível elegível B', amount: 100.01, balance: 100.01, status: 1, minutes: 2, contact: contactSource, expected: 'eligible' },
      { id: '9390000003', entity: 'payables', label: 'Pagamento elegível', amount: 89.5, balance: 89.5, status: 1, minutes: 2, contact: contactSource, expected: 'eligible' },
      { id: '9390000004', entity: 'receivables', label: 'Recebível parcial bloqueado', amount: 100, balance: 20, status: 3, minutes: 2, contact: contactSource, expected: 'partial' },
      { id: '9390000005', entity: 'payables', label: 'Pagamento com coleta expirada', amount: 50, balance: 50, status: 1, minutes: 61, contact: contactSource, expected: 'expired' },
      { id: '9390000006', entity: 'receivables', label: 'Recebível sem contato vinculado', amount: 75, balance: 75, status: 1, minutes: 2, contact: '9399000099', expected: 'unmatched_contact' }
    ];
    for (const item of definitions) {
      const row = await stage(item.entity, item.id, { id: item.id, situacao: item.status, valor: item.amount, saldo: item.balance, historico: `QA039 · ${item.label} · FICTÍCIO`, dataEmissao: dates.issued, vencimento: dates.due, numeroDocumento: `QA039/${item.id}`, contato: { id: item.contact }, ocorrencia: { tipo: 1 }, synthetic_qa: true }, item.minutes);
      await db.query('insert into origin_finance_refresh.origin(entity,source_id) values($1,$2)', [item.entity, item.id]);
      const attempt = randomUUID();
      await db.query(`insert into origin_finance_refresh.attempt(id,entity,source_id,owner,fence,source_hash,source_seen_at,source_status,state,started_at,finished_at,response_hash,response_status,result_hash,result_version)
        values($1,$2,$3,$4,$5,$6,$7,$8,'stored',$7::timestamptz-interval '2 seconds',$7::timestamptz,$6,$8,$6,$9::bigint)`, [attempt, item.entity, item.id, randomUUID(), randomUUID(), row.source_hash, row.last_seen_at, String(item.status), row.source_version]);
      await db.query(`update origin_finance_refresh.origin set current_attempt=$3,last_attempt_at=$4::timestamptz-interval '2 seconds',last_success_at=$4 where entity=$1 and source_id=$2`, [item.entity, item.id, attempt, row.last_seen_at]);
    }
    await db.exec('commit');
    return { synthetic: true, sources: 6, eligible: 3, blocked: 3, native_contacts: 1, native_financial_writes: 0, source_contact: contactSource, native_contact: nativeContact, eligible_sources: definitions.filter(item => item.expected === 'eligible').map(item => ({ entity: item.entity, source_id: item.id })), fixtures: definitions.map(({ id, entity, expected }) => ({ id, entity, expected })) };
  } catch (error) { await db.exec('rollback'); throw error; }
}
