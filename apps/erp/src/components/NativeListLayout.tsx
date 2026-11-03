import {useId,useRef,useState,type ReactNode} from 'react';
import {Icon} from './Icon';
import './native-list-layout.css';
/** Full-width records with contextual tools above the work area. Panels never unmount. */
export default function NativeListLayout({filters,actions,children}:{filters:ReactNode;actions:ReactNode;children:ReactNode}){
 const id=useId(),[panel,setPanel]=useState<'filters'|'actions'|null>(null);
 const filterButton=useRef<HTMLButtonElement>(null),actionButton=useRef<HTMLButtonElement>(null);
 const close=()=>{const previous=panel;setPanel(null);(previous==='filters'?filterButton:actionButton).current?.focus();};
 const toggle=(next:'filters'|'actions')=>setPanel(value=>value===next?null:next);
 return <div className="native-list-layout fagoo-list-workspace" onKeyDown={event=>{if(event.key==='Escape'&&panel){event.preventDefault();close();}}}>
 <div className="native-list-panel-controls"><span className="fagoo-list-label"><Icon name="table-list" size={17}/>Área de trabalho</span><button ref={filterButton} type="button" className="secondary-button" aria-expanded={panel==='filters'} aria-controls={id+'-filters'} onClick={()=>toggle('filters')}><Icon name="filter" size={16}/>Filtros</button><button ref={actionButton} type="button" className="secondary-button" aria-expanded={panel==='actions'} aria-controls={id+'-actions'} onClick={()=>toggle('actions')}><Icon name="sliders" size={16}/>Ações da listagem</button></div>
 <aside className="native-list-filters" id={id+'-filters'} hidden={panel!=='filters'} aria-label="Filtros da listagem"><div className="native-list-aside-heading"><h2>Refinar resultados</h2><button type="button" className="icon-button" aria-label="Fechar filtros" onClick={close}><Icon name="close"/></button></div><div className="fagoo-filter-fields">{filters}</div></aside>
 <aside className="native-list-actions" id={id+'-actions'} hidden={panel!=='actions'} aria-label="Ações da listagem"><div className="native-list-aside-heading"><h2>Operações disponíveis</h2><button type="button" className="icon-button" aria-label="Fechar ações" onClick={close}><Icon name="close"/></button></div><div className="fagoo-list-operations">{actions}</div></aside>
 <section className="native-list-content">{children}</section></div>;
}
