import { useEffect, useState } from 'react';
import { PURPOSE_TEXT, TASK_STATUS_TEXT, TASKS_PATH, moment, parseTasks, taskResultText, type PlatformPort, type PlatformTask } from '../lib/platform-model';

const aborted = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/** Leva H (PRF-280): the server tasks in Consultar gestão de ações, with attempts and history. The administrador sees every
 * task; the other profiles see the tasks they asked for. */
export default function PlatformTasks({ controller }: { controller: Partial<PlatformPort> }) {
  const [tasks, setTasks] = useState<{ all: boolean; items: PlatformTask[] } | null>(null), [error, setError] = useState(''), [open, setOpen] = useState<string | null>(null), [reload, setReload] = useState(0);
  useEffect(() => {
    if (typeof controller.platform !== 'function') return;
    const request = new AbortController(); setError('');
    void controller.platform(TASKS_PATH, { method: 'GET', signal: request.signal }).then(raw => { if (!request.signal.aborted) setTasks(parseTasks(raw)); })
      .catch(e => { if (!request.signal.aborted && !aborted(e)) setError('Não foi possível carregar as tarefas do servidor.'); });
    return () => request.abort();
  }, [controller, reload]);
  if (typeof controller.platform !== 'function') return null;
  return <section className="platform-tasks" aria-labelledby="platform-tasks-title">
    <header className="real-heading"><div><h2 id="platform-tasks-title">Tarefas do servidor</h2>
      <p>{tasks?.all ? 'Notificações agendadas, exportações e limpezas de todos os usuários.' : 'As tarefas que você pediu, como a exportação dos dados.'} Uma tarefa repetida não repete o efeito.</p></div>
      <button type="button" className="secondary-button" onClick={() => setReload(n => n + 1)}>Atualizar</button></header>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {!tasks && !error && <p role="status">Carregando…</p>}
    {tasks && (tasks.items.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th scope="col">Data</th><th scope="col">Tarefa</th><th scope="col">Situação</th>
      <th scope="col">Tentativas</th><th scope="col">Resultado</th><th scope="col"><span className="sr-only">Histórico</span></th></tr></thead>
      <tbody>{tasks.items.map(task => <tr key={task.id}><td>{moment(task.created_at)}</td><td>{PURPOSE_TEXT[task.purpose]}{task.requested_by_name ? ` · ${task.requested_by_name}` : ''}</td>
        <td>{TASK_STATUS_TEXT[task.status]}</td><td>{task.attempts} de {task.max_attempts}</td><td>{taskResultText(task)}</td>
        <td><button type="button" className="text-button" aria-expanded={open === task.id} onClick={() => setOpen(open === task.id ? null : task.id)}>Histórico</button>
          {open === task.id && <ol className="platform-task-history">{task.history.map(h => <li key={h.attempt}>Tentativa {h.attempt}: {moment(h.started_at)}{h.finished_at ? ` → ${moment(h.finished_at)}` : ''}
            {' · '}{h.outcome === 'done' ? 'concluída' : h.outcome === 'retry' ? 'nova tentativa' : h.outcome === 'expired' ? 'tempo esgotado' : h.outcome === 'failed' ? 'falhou' : 'em andamento'}{h.error_code ? ` (${h.error_code})` : ''}</li>)}</ol>}</td></tr>)}</tbody>
    </table></div> : <p className="empty-state">Nenhuma tarefa do servidor registrada.</p>)}
  </section>;
}
