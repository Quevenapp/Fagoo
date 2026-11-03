import { useState } from 'react';
import { Link } from 'react-router-dom';
import { LATEST_RELEASE, markReleaseSeen, releaseSeen } from '../lib/release-notes';
import './help-center.css';

const storage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };

/** Leva H (PRF-255): "Novidades no Brufap! Versão N" on the home page, from the release notes kept in the repository. Closing it
 * hides this version in this browser; the full list stays in Central de ajuda › Novidades. */
export default function ReleaseNotesPanel() {
  const [open, setOpen] = useState(() => !releaseSeen(storage()));
  if (!open) return null;
  return <section className="release-panel" aria-labelledby="release-panel-title">
    <header><h2 id="release-panel-title">Novidades no FAGOO! Versão {LATEST_RELEASE.version}</h2>
      <button type="button" className="text-button" onClick={() => { markReleaseSeen(storage()); setOpen(false); }}>Fechar</button></header>
    <p>{LATEST_RELEASE.title}</p>
    <ul>{LATEST_RELEASE.items.slice(0, 4).map(item => <li key={item}>{item}</li>)}</ul>
    <p><Link to="/ajuda/novidades">Ver todas as novidades</Link></p>
  </section>;
}
