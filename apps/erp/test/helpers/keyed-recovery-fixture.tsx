import {useEffect,useState} from 'react';
function Child({onMount,onCleanup}:{onMount:()=>void;onCleanup:()=>void}){const[count,setCount]=useState(0);useEffect(()=>{onMount();return onCleanup;},[]);return <button onClick={()=>setCount(n=>n+1)}>Count {count}</button>;}
export default function KeyedRecoveryFixture({identity,onMount,onCleanup}:{identity:string;onMount:()=>void;onCleanup:()=>void}){return <Child key={identity} onMount={onMount} onCleanup={onCleanup}/>;}
