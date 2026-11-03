import { FA_ICONS } from './fa-icons';

// Legacy names used across the ERP mapped to the Font Awesome glyphs the Origin interface uses.
const LEGACY: Record<string, string> = {
  search: 'magnifying-glass', plus: 'plus', chevron: 'chevron-down', left: 'chevron-left', right: 'chevron-right',
  more: 'ellipsis-vertical', sun: 'sun', moon: 'moon', filter: 'filter', print: 'print', close: 'xmark',
  arrow: 'arrow-right', columns: 'table-list', check: 'check', info: 'circle-info',
};

export function iconExists(name: string) {
  return Boolean(FA_ICONS[name] || FA_ICONS[LEGACY[name] || '']);
}

export function Icon({ name, size = 18, title, className }: { name: string; size?: number; title?: string; className?: string }) {
  const definition = FA_ICONS[name] || FA_ICONS[LEGACY[name] || ''] || FA_ICONS['ellipsis-vertical'];
  const [width, height, path] = definition;
  return <svg className={`fa-icon${className ? ` ${className}` : ''}`} width={size} height={size} viewBox={`0 0 ${width} ${height}`} fill="currentColor" focusable="false" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
    {title && <title>{title}</title>}
    <path d={path} />
  </svg>;
}
