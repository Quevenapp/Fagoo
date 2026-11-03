import{useEffect,useId,useRef,useState,type FormEvent}from'react';
import type{NativeRequestOptions}from'../lib/real-access';
import{importCategoryAllowed,importCategoryPage,importCategoryPath,type ImportCategory,type ImportCategoryPage,type ImportFinanceKind}from'../lib/financial-import-category';
type Props={controller:{finance(path:string,options?:NativeRequestOptions):Promise<unknown>};kind:ImportFinanceKind;sourceId:string;blocked?:boolean;onSelect:(category:ImportCategory|null)=>void;onClose:()=>void};
/** A category decision is explicit, including the choice to keep a title uncategorized. */
export default function FinancialImportCategoryPicker({controller,kind,sourceId,blocked=false,onSelect,onClose}:Props){
 const current=useRef({blocked,kind,sourceId,onSelect,onClose});current.current={blocked,kind,sourceId,onSelect,onClose};const canChange=()=>!current.current.blocked&&current.current.kind===kind&&current.current.sourceId===sourceId;
 const id=useId(),heading=useRef<HTMLHeadingElement>(null);const[draft,setDraft]=useState(''),[query,setQuery]=useState(''),[cursors,setCursors]=useState<(string|null)[]>([null]),[reload,setReload]=useState(0);
 const[result,setResult]=useState<{key:string;page:ImportCategoryPage}|null>(null),[state,setState]=useState<{key:string;loading:boolean;error:string}>({key:'',loading:true,error:''});
 const path=importCategoryPath(query,cursors.at(-1)??null),key=`${path}|${reload}`;
 useEffect(()=>{heading.current?.focus();},[]);
 useEffect(()=>{const abort=new AbortController();let active=true;setResult(null);setState({key,loading:true,error:''});
  void controller.finance(path,{method:'GET',signal:abort.signal}).then(value=>{if(active)setResult({key,page:importCategoryPage(value)});}).catch(error=>{if(active&&!(error instanceof DOMException&&error.name==='AbortError'))setState({key,loading:false,error:'Não foi possível consultar as categorias. Tente novamente.'});}).finally(()=>{if(active)setState(s=>s.key===key?{...s,loading:false}:s);});
  return()=>{active=false;abort.abort();};},[controller,key,path]);
 const page=result?.key===key?result.page:null,loading=state.key!==key||state.loading,error=state.key===key?state.error:'';
 const submit=(event:FormEvent)=>{event.preventDefault();if(!canChange())return;setQuery(draft.trim());setCursors([null]);setReload(n=>n+1);};
 return<section className="financial-import-category" aria-labelledby={`${id}-heading`}><header><h3 id={`${id}-heading`} ref={heading} tabIndex={-1}>Categoria do título Origin {sourceId}</h3><button type="button" className="secondary-button" disabled={blocked} onClick={()=>{if(canChange())current.current.onClose();}}>Voltar às escolhas</button></header>
  <p className="real-help">Escolha uma categoria ativa compatível com {kind==='receivable'?'contas a receber':'contas a pagar'}, ou decida explicitamente manter este título sem categoria. A versão escolhida será conferida na prévia.</p>
  <form className="financial-import-category-search" onSubmit={submit}><div className="form-field"><label htmlFor={`${id}-query`}>Pesquisar categoria</label><input id={`${id}-query`} type="search" maxLength={120} value={draft} disabled={blocked} onChange={e=>{if(canChange())setDraft(e.target.value);}}/></div><button type="submit" className="secondary-button" disabled={blocked}>Buscar categorias</button></form>
  {error&&<p className="real-error" role="alert">{error}<button type="button" className="text-button" disabled={blocked} onClick={()=>{if(canChange())setReload(n=>n+1);}}>Tentar categorias novamente</button></p>}
  <p role="status">{loading?'Consultando categorias…':page?`${page.items.filter(c=>importCategoryAllowed(c,kind)).length} categoria(s) compatível(is) nesta página`:'Consulta indisponível'}</p>
  {page&&<><ul className="financial-import-category-options">{page.items.filter(c=>importCategoryAllowed(c,kind)).map(category=><li key={category.id}><button type="button" className="secondary-button" disabled={blocked} onClick={()=>{if(canChange()&&importCategoryAllowed(category,kind))current.current.onSelect(category);}}>{category.name}</button><small>Versão {category.version} · {category.kind==='both'?'Receitas e despesas':category.kind==='receivable'?'Receitas':'Despesas'}</small></li>)}</ul>{!page.items.some(c=>importCategoryAllowed(c,kind))&&<p>Nenhuma categoria ativa compatível nesta página. Pesquise ou consulte as próximas páginas.</p>}
   <div className="button-group"><button type="button" className="secondary-button" disabled={blocked||loading||cursors.length===1} onClick={()=>{if(canChange()&&!loading)setCursors(a=>a.slice(0,-1));}}>Categorias anteriores</button><button type="button" className="secondary-button" disabled={blocked||loading||!page.has_more} onClick={()=>{if(canChange()&&!loading&&page.next_cursor)setCursors(a=>[...a,page.next_cursor]);}}>Mais categorias</button></div></>}
  <button type="button" className="secondary-button" disabled={blocked} onClick={()=>{if(canChange())current.current.onSelect(null);}}>Manter este título sem categoria</button>
 </section>;
}
