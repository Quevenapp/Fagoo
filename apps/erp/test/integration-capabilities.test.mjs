import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
import {originIntegrationEnabled,originHistoryAvailable,isOriginIntegrationRoute} from '../src/lib/integration-capabilities.ts';
import {resolvePreferences} from '../src/lib/origin-menu.ts';
import {mountComponent} from './helpers/component-recovery-harness.mjs';

const uid='a0000000-0000-4000-8000-000000000001';
const session={access_token:'synthetic-session',user:{id:uid}};
const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

test('fresh and legacy responses do not poll or request sync; explicit capability enables it',async()=>{
 for(const capabilities of [undefined,{originIntegration:false},{originIntegration:'true'},{originIntegration:false,originHistory:true},{originIntegration:true,originHistory:true}]){
  const calls=[];
  const controller=createAccessController(auth,'https://api.example.test',async(url,options)=>{
   if(url.endsWith('/me'))return Response.json({user_id:uid,role:'admin',resources:[],data_mode:'staging_readonly',capabilities});
   calls.push([url,options.method]);return Response.json({ok:true});
  });
  const stop=controller.start();await tick();
  try{
   const enabled=capabilities?.originIntegration===true;
   assert.equal(originIntegrationEnabled(controller.getSnapshot().membership),enabled);
   for(const method of ['GET','POST']){
    if(enabled)await controller.originSync('/v1/sincronizacao-origin',{method});
    else await assert.rejects(controller.originSync('/v1/sincronizacao-origin',{method}),error=>error instanceof AccessError&&error.status===403);
   }
   assert.equal(calls.length,enabled?2:0);
  }finally{stop();}
 }
});

test('native preferences remain available while historical routes use their independent capability',()=>{
 const paths=capabilities=>resolvePreferences({role:'admin',resources:['contacts','products'],capabilities}).flatMap(category=>category.entries.map(entry=>entry.to));
 const fresh=paths(undefined),historical=paths({originHistory:true,originIntegration:false});
 for(const path of ['/dados-origin','/preparacao-virada','/historico-vendas-origin']){
  assert.equal(isOriginIntegrationRoute(path),true);assert.ok(!fresh.includes(path));assert.ok(historical.includes(path));
 }
 for(const path of ['/empresa-configuracoes','/preferencias/backup/exportacao','/estoque-abertura','/xmls-sincronizados'])assert.ok(fresh.includes(path),path);
 assert.equal(originHistoryAvailable({capabilities:{originHistory:true,originIntegration:false}}),true);
 assert.equal(isOriginIntegrationRoute('/estoque-empresa'),false);
 assert.equal(isOriginIntegrationRoute('/historico-fiscal'),false);
});

test('the fresh top bar omits sync and connector help even when the controller has that method',async()=>{
 for(const enabled of [false,true]){
  const state={phase:'ready',membership:{user_id:uid,role:'admin',resources:[],capabilities:{originIntegration:enabled,originHistory:enabled}}};
  const modules={
   '../lib/real-access':'export const ROLE_LABELS={admin:"Administrador"};',
   '../hooks/useTheme':'export const useTheme=()=>({theme:"light",toggle(){}});',
   './CompanyChrome':'export const useCompanyChrome=()=>({});export const useStoredThemeAtLogin=()=>{};export const NotificationsPanel=()=>null;',
   './OriginTopBar':'export default function Header(p){return r.jsx("header",{children:[p.syncTool,...p.helpLinks.map(link=>r.jsx("a",{children:link.label}))]});}',
   './OriginSyncButton':'export default function Sync(){return r.jsx("button",{children:"Sincronizar"});}',
  };
  const view=await mountComponent('CompanyNavigation.tsx',{state,onLogout(){},controller:{originSync(){throw Error('Unexpected request');}}},{modules,expandChildren:true});
  try{assert.equal(view.text().includes('Sincronizar'),enabled);assert.equal(view.text().includes('Convivência com o Origin'),enabled);}finally{view.unmount();}
 }
});

test('fresh release notes show the FAGOO release and preserve the optional historical note',async()=>{
 for(const enabled of [false,true]){
  const view=await mountComponent('HelpCenter.tsx',{originIntegration:enabled},{location:'/ajuda/novidades',expandChildren:['ReleaseNotesList']});
  try{assert.match(view.text(),/FAGOO com instalação própria e início sem dados/);assert.equal(view.text().includes('Sincronização de mão dupla com o Origin;'),enabled);}finally{view.unmount();}
 }
});
