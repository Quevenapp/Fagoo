// Optional real PostgreSQL concurrency check. Only the named, network-isolated synthetic container.
import { spawn, execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const container = 'brufap-numbering046-pg', database = 'brufap_synthetic';
const manifest = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert.equal(manifest.synthetic, true);
const info = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0];
assert.equal(info.State.Running, true);
assert.equal(info.Config.Image, 'postgres:17-alpine');
assert.equal(info.HostConfig.NetworkMode, 'none');
assert.ok(info.Config.Env.includes('POSTGRES_DB=' + database));
assert.ok(info.HostConfig.Tmpfs['/var/lib/postgresql/data']);
assert.equal(info.Mounts.some(mount => ['volume', 'bind'].includes(mount.Type)), false);
assert.equal(Object.keys(info.HostConfig.PortBindings ?? {}).length, 0);

const sessions = new Set();
function session() {
  const child = spawn('docker', ['exec', '-i', container, 'psql', '-XAtq', '-U', 'postgres', '-d', database,
    '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'], { stdio: ['pipe', 'pipe', 'pipe'] });
  sessions.add(child); let stdout = '', stderr = '', wake, ended = false;
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stdout.on('data', bytes => { stdout += bytes; if (stdout.length > 2097152) child.kill('SIGKILL'); wake?.(); });
    child.stderr.on('data', bytes => { stderr += bytes; if (stderr.length > 65536) child.kill('SIGKILL'); });
    child.on('close', code => { ended = true; clearTimeout(timer); sessions.delete(child); wake?.(); resolve({ code, stdout, stderr }); });
  });
  return { child, done, write: sql => child.stdin.write(sql + '\n'), end: sql => child.stdin.end(sql + '\n'),
    async marker(value) {
      const end = Date.now() + 10000;
      while (!stdout.includes(value)) {
        assert.equal(ended, false, stderr); assert.ok(Date.now() < end, 'First transaction did not reach its marker');
        await new Promise(resolve => { const wait = setTimeout(resolve, 50); wake = () => { clearTimeout(wait); resolve(); }; });
      }
    } };
}
async function sql(value) {
  const client = session(); client.end(value); return client.done;
}
function receipt(result) {
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout.split('\n').find(line => line.startsWith('{')));
}
async function waiting(name) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const result = await sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event_type='Lock';`);
    assert.equal(result.code, 0, result.stderr);
    if (result.stdout.trim() === '1') return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('Second PostgreSQL connection did not wait for a lock');
}
const results = [];
try {
  for (const name of ['same_command', 'competing_commands', 'different_series_same_order']) {
    const scenario = manifest.scenarios[name], a = scenario.calls[0], b = scenario.calls[1] ?? a;
    const first = session(), app = 'brufap046_' + name;
    first.write(`begin; set local lock_timeout='8s'; set local statement_timeout='10s'; set local role service_role;\n${a.sql}\n\\echo BRUFAP_FIRST_RESERVED`);
    await first.marker('BRUFAP_FIRST_RESERVED');
    const second = sql(`set application_name='${app}'; set lock_timeout='8s'; set statement_timeout='10s'; set role service_role;\n${b.sql}`);
    await waiting(app);
    first.end('commit;'); const firstReceipt = receipt(await first.done), secondResult = await second;
    assert.equal(firstReceipt.receipt.number, '1'); assert.equal(firstReceipt.replayed, false);
    if (name === 'same_command') {
      const replay = receipt(secondResult);
      assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, firstReceipt.receipt);
    } else {
      assert.equal(secondResult.code, 3, secondResult.stdout); assert.match(secondResult.stderr, /40001/);
    }
    const state = receipt(await sql(`select jsonb_build_object('reservations',(select count(*) from erp_fiscal_numbering.reservation where series_id='${a.args.p_series_id}'),'next_number',(select next_number from erp_fiscal_numbering.series where id='${a.args.p_series_id}'),'other_next_number',(select next_number from erp_fiscal_numbering.series where id='${b.args.p_series_id}'));`));
    assert.equal(state.reservations, 1); assert.equal(state.next_number, 2);
    assert.equal(state.other_next_number, name === 'different_series_same_order' ? 1 : 2);
    results.push({ scenario: name, lock_wait_observed: true, consumed_numbers: 1,
      second_result: name === 'same_command' ? 'historical_replay' : '40001_conflict' });
  }
  const effects = receipt(await sql("select jsonb_build_object('stock',(select count(*)from erp_stock.movement),'finance',(select count(*)from erp_finance.title),'reservations',(select count(*)from erp_fiscal_numbering.reservation));"));
  assert.deepEqual(effects, { stock: 0, finance: 0, reservations: 3 });
  console.log(JSON.stringify({ synthetic: true, postgres_multi_session: true, scenarios: results, effects }, null, 2));
} finally {
  for (const child of sessions) { child.stdin.end('rollback;\n'); child.kill('SIGTERM'); }
}
