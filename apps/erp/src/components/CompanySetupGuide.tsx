import type {CompanyAccess,CompanyFiscal,CompanyRecord} from '../lib/company-model';

/** Describes only the persisted company record; never infers fiscal readiness. */
export default function CompanySetupGuide({access,identity,fiscal,pending,dirty}:{access:CompanyAccess;identity:CompanyRecord|null;fiscal:CompanyFiscal|null;pending:boolean;dirty:boolean}){
 const regime=access.read_fiscal?(pending?'Consulta atual pendente':fiscal?.confirmed?'Confirmação registrada':'A confirmar'):'Consulta restrita ao perfil fiscal';
 return <section className="company-setup-guide" aria-labelledby="company-setup-heading"><h2 id="company-setup-heading">Preparação da empresa</h2><p>Salve a identificação comercial e depois confira o enquadramento fiscal. As etapas abaixo não habilitam a emissão de notas.</p>
  <ol className="company-setup-steps">
   <li><h3>1. Identificação e endereço</h3><strong>{pending?'Consulta atual pendente':identity?`Cadastro salvo · versão ${identity.version}`:'Cadastro ainda não informado'}</strong><p>Use o cadastro atual da empresa para conferir razão social, CNPJ, endereço e município. Não complete dados ausentes com informações de notas antigas.</p></li>
   <li><h3>2. Regime e inscrição estadual</h3><strong>{regime}</strong><p>{access.read_fiscal?'“Simples Nacional” não seleciona o CRT automaticamente. Confira a opção aplicável e registre a referência da conferência.':'A confirmação do regime é feita por um administrador ou pelo perfil fiscal.'}</p>{!pending&&identity&&!identity.data.ie&&<p className="company-setup-pending">Inscrição estadual não informada. Não é interpretada como isenção.</p>}</li>
   <li><h3>3. Preparação das notas</h3><strong>Etapa separada do cadastro</strong><p>O rascunho fiscal usa uma cópia do pedido salvo e da empresa. Depois de alterar este cadastro, abra o rascunho e confira a atualização da cópia; as escolhas fiscais dos itens precisam ser revistas para a nova revisão.</p></li>
  </ol>
  {dirty&&!pending&&<p className="company-setup-pending">Há alterações no formulário. Os indicadores acima descrevem os dados salvos, não os campos ainda em edição.</p>}
 </section>;
}
