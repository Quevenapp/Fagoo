import React,{createContext,useContext} from 'react';
import {managedApiOperations} from './api-reference';
export {documentationHref} from './api-reference';

const DocumentationContext=createContext('/api-docs');
export function ApiDocumentationProvider({href,children}:{href:string;children:React.ReactNode}){
 return <DocumentationContext.Provider value={href}>{children}</DocumentationContext.Provider>;
}
export function ApiDocumentationLink(props:React.AnchorHTMLAttributes<HTMLAnchorElement>){
 return <a {...props} href={useContext(DocumentationContext)}/>;
}
export function ManagedApiDocumentation({unit}:{unit:{id:string;name:string;capabilities:string[]}}){
 if(!unit.capabilities.includes('communication.configure'))return <section className="fagoo-inbox"><h1>Referência da API</h1><p>A documentação de configuração exige permissão de administrador do atendimento nesta unidade.</p><a href={`/atendimento?unit=${encodeURIComponent(unit.id)}`}>Voltar ao atendimento</a></section>;
 const operations=managedApiOperations(unit.id);
 return <section className="fagoo-inbox"><a href={`/atendimento?unit=${encodeURIComponent(unit.id)}`}>Voltar ao atendimento</a><h1>API de atendimento do Fagoo</h1><p>Unidade: <strong>{unit.name}</strong></p><p>Esta referência usa as operações já implementadas pelo motor de atendimento. Os caminhos são relativos à URL da API da sua instalação e usam a sessão autenticada do Fagoo. O servidor verifica novamente a unidade, as permissões e a atribuição de cada atendimento.</p><p>Não há outro login para o atendimento. Contatos, pessoas, dispositivos e atualizações são gerenciados pelas respectivas áreas do Fagoo.</p><p>Esta página é somente para consulta. Requisições que alteram dados precisam de <code>Idempotency-Key</code>; após uma resposta incerta, consulte o resultado antes de repetir. As políticas de consentimento, janela de atendimento e custo continuam aplicadas pelo servidor.</p><p>Integrações entre servidores usam aplicações e escopos próprios, configurados na área de integrações. Não compartilhe a sessão pessoal com sistemas externos.</p><div className="table-scroll"><table><caption>Operações do atendimento nesta unidade</caption><thead><tr><th>Método</th><th>Caminho</th><th>Descrição</th></tr></thead><tbody>{operations.map(row=><tr key={row.method+row.path}><td><code>{row.method}</code></td><td><code>{row.path}</code></td><td>{row.summary}</td></tr>)}</tbody></table></div></section>;
}
