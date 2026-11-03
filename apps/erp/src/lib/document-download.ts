// Browser-only file save and new-tab helpers for the document screens. Kept apart so tests replace them.
export function downloadText(filename: string, text: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function openExternal(url: string) {
  if (!/^https:\/\/wa\.me\/\d{12,13}\?text=/.test(url)) throw new Error('EXTERNAL_URL_INVALID');
  window.open(url, '_blank', 'noopener,noreferrer');
}
