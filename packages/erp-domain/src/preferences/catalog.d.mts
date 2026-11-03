import type{PreferencePageSchema}from'./core.mjs';
export const PREFERENCE_PAGES:readonly PreferencePageSchema[];
export const STORED_PREFERENCE_PAGES:readonly PreferencePageSchema[];
export function preferencePage(id:string):PreferencePageSchema|null;
export function storedPreferencePage(id:string):PreferencePageSchema|null;
export function preferencePageByRoute(category:string,path:string):PreferencePageSchema|null;
export function preferencePageHref(page:PreferencePageSchema,section?:string|null):string;
