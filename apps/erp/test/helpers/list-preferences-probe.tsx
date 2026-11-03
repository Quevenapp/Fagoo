// Test-only list that adopts useListPreferences the way a Origin list does (columns + "Tornar padrão").
import {useListPreferences,type ListPreferencesPort,type ListFilters} from '../../src/hooks/useListPreferences';
import ListPreferencesBar,{type ListColumnsDrawer} from '../../src/components/ListPreferencesBar';
const COLUMNS=[{id:'numero',label:'Número'},{id:'cliente',label:'Cliente'},{id:'data',label:'Data'},{id:'total',label:'Total'}];
export default function ListPreferencesProbe({controller,listId='documentos.sales_orders',currentFilters={},drawer}:{controller:ListPreferencesPort;listId?:string;currentFilters?:ListFilters;drawer?:ListColumnsDrawer}){
 const prefs=useListPreferences(controller,listId,{available:COLUMNS.map(c=>c.id),defaults:['numero','cliente','total']});
 return <section><p data-columns={prefs.columns.join(',')}>Colunas: {prefs.columns.join(',')}</p><p>Filtro padrão: {prefs.filters?JSON.stringify(prefs.filters):'nenhum'}</p>
  <ListPreferencesBar prefs={prefs} columns={COLUMNS} currentFilters={currentFilters} drawer={drawer}/></section>;
}
