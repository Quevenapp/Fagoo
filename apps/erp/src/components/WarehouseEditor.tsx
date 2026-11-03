import { CATALOG_FIELDS, type CatalogField } from '../lib/catalog-model';
import { Field, originFields, catalogEditorView, useCatalogEditor, type CatalogEditorProps } from './CatalogEditor';

// Formulário de Depósito: nome, código e descrição.
export function WarehouseEditor(props: CatalogEditorProps) {
  const editor = useCatalogEditor(props);
  const field = (item: CatalogField) => <Field key={item.key} field={item} values={editor.values} invalid={editor.invalidField === item.key} onChange={editor.changeField} />;
  return catalogEditorView(editor, props, {
    title: 'Depósito', saveLabel: 'Salvar',
    form: locked => <fieldset disabled={locked} className="real-editor-fields">
      <legend className="real-sr-only">Dados do cadastro</legend>
      {originFields(CATALOG_FIELDS.warehouses, {}).map(field)}
    </fieldset>,
  });
}
