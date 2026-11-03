/** FAGOO mark: two offset routes form an open F. Original vector, 2026-11-03. */
export function FagooBrand({compact=false}:{compact?:boolean}) {
 return <span className="fagoo-brand"><svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M7 26V10a4 4 0 0 1 4-4h15" stroke="currentColor" strokeWidth="5" strokeLinecap="round"/><path d="M14 26V18a3 3 0 0 1 3-3h7" stroke="currentColor" strokeWidth="5" strokeLinecap="round"/><circle cx="26" cy="25" r="3" fill="currentColor" opacity=".55"/></svg>{!compact&&<span>fagoo<span className="fagoo-brand-dot">.</span></span>}</span>;
}
