export type DanfeCurrent = Readonly<{
  artifact_current: boolean; basis_changed: boolean; draft_archived: boolean;
  source_cancelled: boolean; is_latest_candidate: boolean; a1_changed: boolean;
}>;
export type DanfePreview = Readonly<{
  data_mode: 'fiscal_danfe_preview'; read_only: true; environment: '2';
  authorized: false; authorization_verified: false; can_emit: false; can_transmit: false;
  candidate_id: string; candidate_version: number; model: '55' | '65';
  source_sha256: string; source_size_bytes: number;
  html: string; html_sha256: string; html_size_bytes: number;
  page_count: number | null;
  profile: 'candidate-danfe55-moc7-v1' | 'candidate-danfe65-manual6-v1';
  current: DanfeCurrent;
}>;
export const FLAGS: Readonly<Pick<DanfePreview, 'data_mode' | 'read_only' | 'environment' | 'authorized' | 'authorization_verified' | 'can_emit' | 'can_transmit'>>;
export const HTML_CSP: string;
export const CURRENT_KEYS: readonly (keyof DanfeCurrent)[];
export function publicResult(value: unknown, options: {candidateId: string}): Promise<DanfePreview>;
