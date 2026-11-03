// Espaço Meu Contador › Arquivos (notas fiscais lane, wave E): the competência of the package.
/** Previous month in São Paulo ("aaaa-mm"), the usual competência delivered to the accountant. */
export function previousCompetence(now = new Date()): string {
  const [year, month] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).format(now).split('-').map(Number);
  return month === 1 ? `${year! - 1}-12` : `${year}-${String(month! - 1).padStart(2, '0')}`;
}
/** First and last day of a competência "aaaa-mm" (null when invalid or outside 1900-2099). */
export function competenceRange(value: string): { from: string; to: string } | null {
  const match = /^(19\d{2}|20\d{2})-(0[1-9]|1[0-2])$/.exec(value); if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${value}-01`, to: `${value}-${String(last).padStart(2, '0')}` };
}
/**
 * One cell of resumo.csv (separator ";"): always quoted, and a value that starts like a spreadsheet formula (=, +, -, @, after spaces
 * or controls, or a tab / line break) gets an apostrophe, so a contact name from the Origin never runs as a formula.
 */
export const summaryCell = (value: string) => `"${(/^[\s\u0000-\u001f]*[=+@-]|^[\t\r\n]/u.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`;
