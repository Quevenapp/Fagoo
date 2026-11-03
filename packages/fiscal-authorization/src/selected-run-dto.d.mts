import type {PreflightSelection} from './preflight-dto.mjs';
export const SELECTED_RUN_PROFILE:'authorization-reviewed-selection-v1';
export const SELECTION_KEYS:readonly string[];
export type SelectedRunInput=PreflightSelection&Readonly<{request_profile:typeof SELECTED_RUN_PROFILE;command_id:string;confirmed:true}>;
export function captureReviewedSelection(value:unknown):PreflightSelection;
export function captureSelectedRun(value:unknown):SelectedRunInput;
