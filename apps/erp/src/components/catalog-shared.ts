import { AccessError } from '../lib/real-access';
import type { CatalogEntity } from '../lib/catalog-model';

// Shared by the catalog list (CatalogList.tsx) and editors (CatalogEditor.tsx) of every entity.
// Origin wording for the same screens (docs/references/origin-interface.md, "Cadastros > Produtos" and "Clientes e fornecedores").
export const LIST_TITLE: Record<CatalogEntity, string> = { contacts: 'Clientes e Fornecedores', products: 'Produtos', warehouses: 'Depósitos' };
export const situation = (active: boolean) => active ? 'Ativo' : 'Inativo';

export const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
export const CONFLICT_TEXT = 'Este cadastro foi alterado por outra operação. Reabra o registro antes de salvar; suas alterações ainda estão no formulário.';
export const errorText = (error: unknown) => error instanceof AccessError ? error.status === 409
  ? CONFLICT_TEXT
  : error.status === 403 ? 'Seu perfil não tem permissão para esta operação.'
  : error.status === 404 ? 'O cadastro não foi encontrado. Atualize a listagem.'
  : error.status === 400 ? 'Confira os campos informados antes de tentar novamente.'
  : 'Não foi possível concluir a operação. Tente novamente.' : 'Não foi possível concluir a operação. Tente novamente.';
export const knownFailure = (error: unknown) => error instanceof AccessError && [400, 403, 404, 409].includes(error.status);
