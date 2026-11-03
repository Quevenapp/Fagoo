// Pendências do painel "Validação do produto" (formulário de produtos): preço, nome, código (salvo com o código Sequencial) e unidade.
export type ValidationIssue = { key: 'price' | 'name' | 'code' | 'unit'; label: string };
export function productIssues(values: Record<string, string>, { sequential = false }: { sequential?: boolean } = {}): ValidationIssue[] {
  const price = (values.price ?? '').trim().replace(',', '.');
  return [
    ...(!price || /^0+(?:\.0*)?$/.test(price) ? [{ key: 'price' as const, label: 'Verificar preço' }] : []),
    ...(!(values.name ?? '').trim() ? [{ key: 'name' as const, label: 'Inserir nome' }] : []),
    ...(!(values.code ?? '').trim() && !sequential ? [{ key: 'code' as const, label: 'Inserir código' }] : []),
    ...(!(values.unit ?? '').trim() ? [{ key: 'unit' as const, label: 'Inserir unidade' }] : []),
  ];
}
