import {build} from 'esbuild';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {decimalMoney} from '../../src/lib/real-access.ts';

// Deterministic hook runner for async recovery contracts. It executes the actual
// component handlers; it does not claim to model browser layout or React routing.
export class AccessError extends Error {constructor(status){super(`HTTP ${status}`);this.status=status;}}
const registry=globalThis.__brufapRecoveryTests??=new Map();
export async function mountComponent(filename,props,{componentName,expandChildren=false,location:initialLocation='/qa',modules={},ports={}}={}){
 if(componentName&&!/^[A-Za-z_$][\w$]*$/.test(componentName))throw new Error('Invalid component name');
 const key=randomUUID(),frames=new Map(),effects=[];let current,index=0,dirty=true,tree,disposed=false,idCount=0;
 let location;const navigations=[];const navigate=(target,options)=>{const url=new URL(typeof target==='string'?target:`${target.pathname??location.pathname}${target.search??''}`,'https://synthetic.invalid');location={pathname:url.pathname,search:url.search,hash:url.hash,key:randomUUID(),...(options?.state!==undefined?{state:options.state}:{})};navigations.push({search:url.search,replace:Boolean(options?.replace)});dirty=true;};navigate(initialLocation);
 const runtime={AccessError,decimalMoney,guard:null,
  useState(initial){const frame=current,slots=frame.slots,i=index++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],value=>{if(disposed||!frame.alive)return;const next=typeof value==='function'?value(slots[i]):value;if(!Object.is(next,slots[i])){slots[i]=next;dirty=true;}}];},
  useRef(initial){const i=index++;return current.slots[i]??=( {current:initial} );},
  useId(){return runtime.useRef(`recovery-${++idCount}`).current;},
  useMemo(fn,deps){const slots=current.slots,i=index++,old=slots[i];if(!old||!deps||deps.some((v,j)=>!Object.is(v,old.deps[j])))slots[i]={deps,value:fn()};return slots[i].value;},
  useLocation(){return location;},useNavigate(){return navigate;},
  useSearchParams(){return[new URLSearchParams(location.search),value=>navigate(`${location.pathname}?${typeof value==='function'?value(new URLSearchParams(location.search)):value}`)];},
  useEffect(fn,deps){const slots=current.slots,i=index++,old=slots[i];if(!old||!deps||deps.some((v,j)=>!Object.is(v,old.deps[j]))){slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{slots[i].cleanup?.();slots[i].cleanup=fn();});}},
  useSyncExternalStore(subscribe,getSnapshot){const [value,setValue]=runtime.useState(getSnapshot);runtime.useEffect(()=>{const sync=()=>setValue(getSnapshot());const stop=subscribe(sync);sync();return stop;},[subscribe,getSnapshot]);return value;},
  useUnsavedChanges(changed,busy){runtime.guard={changed,busy};return{confirmLeave:action=>action(),store:{runConfirmed:action=>action()}};},
  useUnsavedForm(value,busy){const serialized=JSON.stringify(value),[baseline]=runtime.useState(serialized);return runtime.useUnsavedChanges(serialized!==baseline,busy);},
  useUnsavedChangesGuard(){return{confirmLeave:action=>action()};},
  jsx:(type,props,key)=>({type,key,props:props||{}}),Fragment:'fragment',
 };
 runtime.useLayoutEffect=runtime.useEffect;Object.assign(runtime,ports);registry.set(key,runtime);
 const entry=fileURLToPath(new URL(`../../src/components/${filename}`,import.meta.url));
 const result=await build({entryPoints:[entry],bundle:true,write:false,format:'esm',jsx:'automatic',logLevel:'silent',define:{'import.meta.env':'{}'},plugins:[{name:'recovery-test-hooks',setup(builder){
  builder.onResolve({filter:/.*/},args=>Object.hasOwn(modules,args.path)?{path:args.path,namespace:'test-module'}:undefined);
  builder.onResolve({filter:/^\//,namespace:'test-module'},args=>({path:args.path,namespace:'file'}));
  builder.onResolve({filter:/^[A-Za-z]:[\\/]/,namespace:'test-module'},args=>({path:args.path,namespace:'file'}));
  builder.onLoad({filter:/.*/,namespace:'test-module'},args=>({contents:`const r=globalThis.__brufapRecoveryTests.get(${JSON.stringify(key)});\n${modules[args.path]}`,loader:'js'}));
  // Export a private editor only in this in-memory test bundle. Production source is untouched.
  if(componentName)builder.onLoad({filter:/\.tsx$/},async args=>args.path===entry?{contents:`${await readFile(entry,'utf8')}\nexport {${componentName} as __recoveryComponent};`,loader:'tsx'}:undefined);
  builder.onResolve({filter:/^(react(?:\/jsx-runtime)?|react-dom|react-router-dom|.*\/hooks\/useUnsavedChanges|.*\/lib\/real-access)$/},args=>({path:args.path,namespace:'test-hooks'}));
  builder.onLoad({filter:/.*/,namespace:'test-hooks'},args=>({contents:`const r=globalThis.__brufapRecoveryTests.get(${JSON.stringify(key)});`+(args.path==='react'?'export const useState=r.useState,useRef=r.useRef,useEffect=r.useEffect,useLayoutEffect=r.useLayoutEffect,useId=r.useId,useMemo=r.useMemo,useSyncExternalStore=r.useSyncExternalStore;':args.path==='react/jsx-runtime'?'export const jsx=r.jsx,jsxs=r.jsx,Fragment=r.Fragment;':args.path==='react-dom'?'export const createPortal=child=>child;':args.path==='react-router-dom'?'export const Link="test-router-link",useLocation=r.useLocation,useNavigate=r.useNavigate,useSearchParams=r.useSearchParams;':args.path.endsWith('useUnsavedChanges')?'export const useUnsavedChanges=r.useUnsavedChanges,useUnsavedForm=r.useUnsavedForm,useUnsavedChangesGuard=r.useUnsavedChangesGuard;':'export const AccessError=r.AccessError,decimalMoney=r.decimalMoney;'),loader:'js'}));
  builder.onLoad({filter:/\.css$/},()=>({contents:'',loader:'js'}));
 }}]});
 const compiled=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`),Component=componentName?compiled.__recoveryComponent:compiled.default;
 const invoke=(component,values,path)=>{let frame=frames.get(path);if(!frame){frame={slots:[],alive:true};frames.set(path,frame);}frame.seen=true;const saved=current,savedIndex=index;current=frame;index=0;const result=component(values);current=saved;index=savedIndex;return result;};
 const expand=(value,path)=>{if(Array.isArray(value))return value.map((child,i)=>expand(child,`${path}/${child?.key??i}`));if(!value||typeof value!=='object'||!value.props)return value;if(typeof value.type==='function'){if(Array.isArray(expandChildren)&&!expandChildren.includes(value.type.name))return value;const componentPath=`${path}:${value.type.name}:${value.key??''}`;return expand(invoke(value.type,value.props,componentPath),`${componentPath}/render`);}return{...value,props:{...value.props,children:expand(value.props.children,`${path}/children`)}};};
 const render=()=>{if(disposed)return;dirty=false;for(const frame of frames.values())frame.seen=false;tree=invoke(Component,props,'root');if(expandChildren)tree=expand(tree,'root/tree');for(const[path,frame]of frames){if(!frame.seen){frame.alive=false;for(const slot of frame.slots)slot?.cleanup?.();frames.delete(path);}}while(effects.length)effects.shift()();};
 const flush=async()=>{let stable=0;for(let i=0;i<100&&stable<5;i++){if(dirty){render();stable=0;}await new Promise(resolve=>setTimeout(resolve,1));stable=dirty?0:stable+1;}if(dirty||stable<5)throw new Error('Component did not settle');};
 const nodes=()=>{const output=[];const walk=(value,disabled=false)=>{if(Array.isArray(value)){value.forEach(v=>walk(v,disabled));return;}if(!value||typeof value!=='object')return;const own=disabled||value.type==='fieldset'&&Boolean(value.props.disabled);output.push({...value,disabled:own||Boolean(value.props.disabled)});walk(value.props.children,own);};walk(tree);return output;};
 const textOf=value=>Array.isArray(value)?value.map(textOf).join(''):value&&typeof value==='object'?textOf(value.props?.children):value===null||value===undefined||typeof value==='boolean'?'':String(value);
 const find=predicate=>{const found=nodes().find(predicate);if(!found)throw new Error('Missing component control');return found;};
 render();await flush();
 return{flush,nodes,find,text:()=>textOf(tree),button:label=>find(n=>n.type==='button'&&textOf(n)===label),input:id=>find(n=>n.props.id===id),guard:()=>runtime.guard,
  location:()=>({...location}),navigations:()=>navigations.map(entry=>({...entry})),async navigate(target){navigate(target);await flush();},async updateProps(next){props={...props,...next};dirty=true;await flush();},
  async click(label){const node=this.button(label);if(node.disabled)throw new Error(`Disabled button: ${label}`);node.props.onClick?.({preventDefault(){}});await flush();},
  async change(id,value){const node=this.input(id);if(node.disabled)throw new Error(`Disabled input: ${id}`);node.props.onChange({target:{value,checked:Boolean(value)}});await flush();},
  async submit(form=0){nodes().filter(n=>n.type==='form')[form].props.onSubmit({preventDefault(){}});await flush();},
  unmount(){disposed=true;for(const frame of frames.values())for(const slot of frame.slots)slot?.cleanup?.();registry.delete(key);},
 };
}
