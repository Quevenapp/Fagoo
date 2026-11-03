import { FAGOO_PATHS, FAGOO_ALIASES } from './fagoo-icons';

// Compatibility aliases keep module behavior stable while the visual language changes.
const LEGACY: Record<string, string> = {
  search: 'magnifying-glass', plus: 'plus', chevron: 'chevron-down', left: 'chevron-left', right: 'chevron-right',
  more: 'ellipsis-vertical', sun: 'sun', moon: 'moon', filter: 'filter', print: 'print', close: 'xmark',
  arrow: 'arrow-right', columns: 'table-list', check: 'check', info: 'circle-info',
};

export function iconExists(name: string) {
  return Boolean(FAGOO_PATHS[FAGOO_ALIASES[name] || LEGACY[name] || name]);
}

export function Icon({ name, size = 18, title, className }: { name: string; size?: number; title?: string; className?: string }) {
  const path = FAGOO_PATHS[FAGOO_ALIASES[name] || name] || FAGOO_PATHS.more;
  return <svg className={`fagoo-icon fa-icon${className ? ` ${className}` : ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
    {title && <title>{title}</title>}
    <path d={path} />
  </svg>;
}
