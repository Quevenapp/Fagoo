import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as access from '../src/lib/real-access.ts';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { resolvePreferences, resolveMenu } from '../src/lib/origin-menu.ts';

// RealAccess routes of the invoice screens with stubbed modules: which screen opens for which profile.
const ACTOR = '10000000-0000-4000-8000-000000000001';
async function mountRoute(location, role) {
  const names = [...String(await readFile(new URL('../src/components/native-modules.ts', import.meta.url), 'utf8')).matchAll(/export const (\w+) = lazy/g)].map(x => x[1])
    .filter(x => !['RealFiscalInvoices', 'RealOperationNatures', 'FiscalEventList', 'HistoryView'].includes(x));
  const state = { phase: 'ready', membership: { user_id: ACTOR, role, resources: [], data_mode: 'staging_readonly' }, permissionMessage: null, records: null, listPending: false, loginPending: false, message: null, logoutFailed: false };
  const controller = { start: () => () => {}, subscribe: () => () => {}, getSnapshot: () => state, retry() {}, logout() {} };
  return mountComponent('RealAccess.tsx', {}, { componentName: 'ConnectedArea', location, expandChildren: ['NativeModuleBoundary', 'FiscalInvoiceRoutes', 'RealFiscalInvoices', 'RealOperationNatures', 'FiscalEventList', 'HistoryView'], ports: { access, controller }, modules: {
    '../lib/real-access': 'export const createAccessController=()=>r.controller;export const {AccessError,decimalMoney,RESOURCE_LABELS,ROLE_LABELS}=r.access;',
    '@supabase/supabase-js': 'export const createClient=()=>({auth:{}});',
    '../lib/access-config': 'export const accessConfig=()=>({supabaseUrl:"https://synthetic.supabase.co",publicKey:"synthetic",apiUrl:"https://api.synthetic.test"});',
    './NativeModuleBoundary': 'export default function NativeModuleBoundary({children}){return children;}',
    './CompanyNavigation': 'export default function CompanyNavigation(){return null;}',
    './native-modules': `export function RealFiscalInvoices(p){return 'LIST:'+p.screen+(p.backup?':backup':'');}export function RealOperationNatures(){return 'NATURES';}export function FiscalEventList(p){return 'EVENTS:'+p.kind;}export function HistoryView(p){return 'BACKUP:'+p.initialModel;}${names.map(n => `export function ${n}(){return null;}`).join('')}`,
  } });
}

test('Notas fiscais de saída, NFC-e and entrada keep their menu addresses and open the Origin lists for the fiscal readers', async () => {
  for (const [location, role, expected] of [['/historico-fiscal?modelo=55', 'consulta', 'LIST:nfe:backup'], ['/historico-fiscal?modelo=65', 'fiscal', 'LIST:nfce:backup'], ['/historico-fiscal', 'admin', 'LIST:nfe:backup'],
    ['/notas-entrada', 'fiscal', 'LIST:entrada'], ['/naturezas-operacao', 'consulta', 'NATURES'], ['/inutilizacoes-nfe', 'fiscal', 'EVENTS:inutilization'], ['/cartas-correcao', 'admin', 'EVENTS:correction']]) {
    const view = await mountRoute(location, role);
    try { assert.ok(view.text().includes(expected), `${location} ${role}: ${view.text().slice(0, 120)}`); } finally { view.unmount(); }
  }
  for (const [location, role, expected] of [['/historico-fiscal?modelo=55', 'vendas', 'Notas fiscais não liberadas'], ['/notas-entrada', 'estoque', 'Notas fiscais não liberadas'], ['/naturezas-operacao', 'financeiro', 'Notas fiscais não liberadas'],
    ['/inutilizacoes-nfe', 'consulta', 'Consulta não liberada'], ['/cartas-correcao', 'vendas', 'Consulta não liberada']]) {
    const view = await mountRoute(location, role);
    try { assert.ok(view.text().includes(expected), `${location} ${role}`); assert.equal(view.text().includes('LIST:'), false); } finally { view.unmount(); }
  }
});

test('the Origin menu still points to the same addresses and Preferências lists the fiscal tables by profile', () => {
  const vendas = resolveMenu('real', { role: 'fiscal', resources: ['nfe', 'nfce'] }).find(g => g.name === 'Vendas').columns[0].items;
  assert.equal(vendas.find(i => i.label === 'Notas fiscais de saída').to, '/historico-fiscal?modelo=55'); assert.equal(vendas.find(i => i.label === 'NFC-e').to, '/historico-fiscal?modelo=65');
  const labels = role => resolvePreferences({ role, resources: [] }).find(c => c.id === 'notas-fiscais')?.entries.map(e => e.label) ?? [];
  assert.ok(labels('fiscal').includes('Naturezas de operação') && labels('fiscal').includes('Consulta de inutilizações de NF-es') && labels('fiscal').includes('Consulta de correções de NF-es'));
  assert.deepEqual(labels('consulta').filter(l => l.startsWith('Consulta de')), []); assert.ok(labels('consulta').includes('Naturezas de operação'));
  assert.deepEqual(labels('vendas'), []);
});
