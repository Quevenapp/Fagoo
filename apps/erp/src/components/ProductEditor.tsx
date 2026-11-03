import { originHistoryAvailable } from '../lib/integration-capabilities';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import ProductVariations from './ProductVariations';
import OriginMirrorPanel from './OriginMirrorPanel';
import { Link } from 'react-router-dom';
import { AccessError } from '../lib/real-access';
import { invalidField } from '../lib/catalog-base';
import { PRODUCT_FIELDS, type CatalogEnvelope, type CatalogRecord } from '../lib/catalog-model';
import {
  DETAIL_FIELDS, EMPTY_LISTS, FCI_ORIGINS, PRODUCT_TABS, TAXONOMY_SLUG, checkWeights, ofTagType, productDetailPayload, productFormValues, productLists, taxonomyItems, taxonomyPath, taxonomyTree,
  type DetailField, type ProductLists, type ProductSupplier, type ProductTab, type TaxonomyItem, type TaxonomyKind,
} from '../lib/product-form-model';
import { loadProductSettings, loadWeightDecimals, type ProductCodeMode } from '../lib/product-settings';
import { catalogEditorView, useCatalogEditor, type CatalogEditorProps } from './CatalogEditor';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { TagsDrawer } from './TagsDrawer';
import { SearchableSelect, type SearchOption } from './SearchableSelect';
import { ProductValidationPanel } from './ProductValidationPanel';
import { ProductCustomFields, useCustomFields } from './ProductCustomFields';
// Wave D (migration 193): Imagens armazenadas (upload, order and removal) next to the external images.
import ProductStoredImages, { useStoredMainImage } from './ProductStoredImages';
import { customValuesPayload, lostCustomValues, visibleCustomFields, type CustomField } from '../lib/custom-fields';
import { aborted, errorText } from './catalog-shared';
// Estoque lane (183): "Saldo inicial" of the inclusion, saved with the product by one stock command.
import { EMPTY_INITIAL_BALANCE, StockInitialBalanceFields, initialBalanceAllowed, initialBalancePayload, type InitialBalanceDraft } from './StockInitialBalance';
// Estoque lane (222): "Estrutura" of a composition, saved with the product by one stock command.
import { ProductStructurePanel, compositionSavePayload, useProductComposition } from './ProductComposition';
// Estoque lane (258): the lots of a product with "Controle de lote" (grade de lotes, "+ Adicionar lote").
import { ProductLots } from './StockLots';
import './product-registry.css';

// Formulário de Produto no padrão do Origin: Dados básicos com a imagem principal e o "Ativado", e as abas Características,
// Imagens (externas), Estoque, Fornecedores e Tributação. O detalhe (migração 119) é lido e gravado pela rota completa do
// produto, num único comando com versão esperada, "Conferir resultado" e aviso de alterações não salvas. Onda D (191): o
// assistente "Cadastrar novo produto" em etapas, Itens p/ caixa decimal, os campos do IPI pelo regime e o Sequencial EAN.
type Taxonomies = Partial<Record<TaxonomyKind, TaxonomyItem[]>> & { failed?: boolean };
const KINDS: TaxonomyKind[] = ['categories', 'product_groups', 'tag_groups', 'tags'];
const BASE: Record<string, { label: string; max?: number; info?: string; placeholder?: string; options?: { value: string; label: string }[]; kind?: 'textarea' | 'select' }> = {
  name: { label: 'Nome', max: 120 }, code: { label: 'Código (SKU)', max: 60, info: 'Referência ou código SKU do produto' },
  format: { label: 'Formato', kind: 'select', options: [{ value: 'S', label: 'Simples (Item único e sem variação)' }, { value: 'V', label: 'Com variações (Grade de tamanhos, cores, etc)' }, { value: 'E', label: 'Com composição (Kit ou união de vários itens)' }] },
  kind: { label: 'Tipo', kind: 'select', options: [{ value: 'P', label: 'Produto' }, { value: 'S', label: 'Serviço' }] },
  price: { label: 'Preço venda', max: 80, info: 'Até dez casas decimais, sem arredondar o preço.' }, unit: { label: 'Unidade', max: 6, placeholder: 'Un, Pç, Kg', info: 'Exemplo: Un, Pç, Kg' },
  condition: { label: 'Condição', kind: 'select', options: [{ value: 'unspecified', label: 'Não Especificado' }, { value: 'new', label: 'Novo' }, { value: 'used', label: 'Usado' }, { value: 'refurbished', label: 'Recondicionado' }] },
  brand: { label: 'Marca', max: 45, info: 'Especifique a marca do produto. Pode ser própria.' },
  production: { label: 'Produção', kind: 'select', options: [{ value: 'own', label: 'Própria' }, { value: 'third_party', label: 'Terceiros' }] },
  net_weight: { label: 'Peso Líquido', max: 19, info: 'Em Kg' }, gross_weight: { label: 'Peso Bruto', max: 19, info: 'Em Kg' },
  width: { label: 'Largura', max: 19 }, height: { label: 'Altura', max: 19 }, depth: { label: 'Profundidade', max: 19 },
  volumes: { label: 'Volumes', max: 6, info: 'Quantidade total de volumes que o produto precisa ser dividido para entrega' },
  items_per_box: { label: 'Itens p/ caixa', max: 13, info: 'Quantidade de itens por caixa/embalagem' },
  dimension_unit: { label: 'Unidade de medida', kind: 'select', options: [{ value: 'm', label: 'Metros' }, { value: 'cm', label: 'Centímetros' }, { value: 'mm', label: 'Milímetros' }] },
  gtin: { label: 'GTIN/EAN', max: 14, placeholder: 'SEM GTIN' }, gtin_tax: { label: 'GTIN/EAN tributário', max: 14, placeholder: 'SEM GTIN' },
  description: { label: 'Descrição curta (Descrição Principal)', max: 4000, kind: 'textarea' },
  stock_min: { label: 'Mínimo', max: 19 }, stock_max: { label: 'Máximo', max: 19 }, location: { label: 'Localização', max: 50, placeholder: 'Ex.: Corredor 4, seção 2A' },
  origin: { label: 'Origem', kind: 'select', options: PRODUCT_FIELDS.find(field => field.key === 'origin')!.options!.map(option => ({ value: option.value, label: option.label.replace(' — ', ' - ') })) },
  ncm: { label: 'NCM', max: 10, placeholder: '0000.00.00' }, cest: { label: 'CEST', max: 9 },
  additional_info: { label: 'Informações Adicionais', max: 2000, kind: 'textarea', info: 'Texto enviado ao campo de informações adicionais do item na nota fiscal.' },
};
const BASE_TAB: Record<string, ProductTab> = Object.fromEntries([['brand', 'characteristics'], ['production', 'characteristics'], ['net_weight', 'characteristics'], ['gross_weight', 'characteristics'],
  ['width', 'characteristics'], ['height', 'characteristics'], ['depth', 'characteristics'], ['volumes', 'characteristics'], ['items_per_box', 'characteristics'], ['dimension_unit', 'characteristics'],
  ['gtin', 'characteristics'], ['gtin_tax', 'characteristics'], ['description', 'characteristics'], ['stock_min', 'stock'], ['stock_max', 'stock'], ['location', 'stock'], ['lot_control', 'stock'], ['origin', 'tax'], ['ncm', 'tax'], ['cest', 'tax'], ['additional_info', 'tax']]);
const tabOf = (key: string): ProductTab | null => key.startsWith('custom-') ? 'characteristics' : BASE_TAB[key] ?? DETAIL_FIELDS.find(field => field.key === key)?.tab
  ?? (['dun_codes', 'tag_ids', 'category_id'].includes(key) ? 'characteristics' : key === 'images' ? 'images' : key === 'suppliers' ? 'suppliers' : key === 'product_group_id' ? 'tax' : key === 'composition' ? STRUCTURE_TAB : null);
// Estoque lane (222): the Estrutura tab exists only for the format "Com composição" (after Estoque, as the stock settings it holds).
const STRUCTURE_TAB = 'structure' as string as ProductTab;
const withStructure = (format: string | undefined) => format === 'E' ? [...PRODUCT_TABS.slice(0, 3), { key: STRUCTURE_TAB, label: 'Estrutura' }, ...PRODUCT_TABS.slice(3)] : PRODUCT_TABS;
// Categoria and Grupo de Produtos (Origin): a searchable tree; a saved link to a removed item stays visible until changed.
const treeOptions = (items: readonly TaxonomyItem[], empty: string, current: string | undefined, missing: string): SearchOption[] => [{ value: '', label: empty },
  ...taxonomyTree(items).map(({ item, depth }) => ({ value: item.id, label: item.name, depth })), ...(current && !items.some(item => item.id === current) ? [{ value: current, label: missing }] : [])];
const ncmMask = (value: string) => value.replace(/^(\d{4})(\d{1,2})?(\d{1,2})?$/, (_, a, b, c) => [a, b, c].filter(Boolean).join('.'));

/** Loads the complete product (detail of migration 119) and the taxonomies, then opens the form. */
export function ProductEditor(props: CatalogEditorProps) {
  const { controller, record } = props;
  const [complete, setComplete] = useState<CatalogRecord | null>(null), [error, setError] = useState('');
  const [taxonomies, setTaxonomies] = useState<Taxonomies>({});
  // A clone is a new product too: it keeps the source's Origem but shows the Sequencial code hint like any inclusion.
  const [settings, setSettings] = useState<FormSettings | null>(record ? EDIT_SETTINGS : null);

  const [attempt, setAttempt] = useState(0);
  // Preferências > Empresa > Geral: decimals of the weights (display and the check of a changed weight); 3 when unreadable.
  const [weightDecimals, setWeightDecimals] = useState<number | null>(null);
  useEffect(() => {
    const request = new AbortController();
    void Promise.resolve().then(() => loadWeightDecimals(controller, request.signal)).then(value => { if (!request.signal.aborted) setWeightDecimals(value); })
      .catch(() => { if (!request.signal.aborted) setWeightDecimals(3); });
    return () => request.abort();
  }, [controller]);
  useEffect(() => {
    if (!record) return;
    const request = new AbortController(); setError('');
    void controller.catalog(`/v1/cadastros/products/${record.id}/completo`, { signal: request.signal }).then(value => {
      const result = value as CatalogEnvelope;
      if (request.signal.aborted) return;
      if (result.record?.id !== record.id || result.record.entity !== 'products' || !Number.isInteger(result.record.version)) throw new AccessError(502);
      setComplete(result.record);
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) setError(errorText(failure)); });
    return () => request.abort();
  }, [controller, record?.id, record?.version, attempt]);
  useEffect(() => {
    const request = new AbortController();
    void Promise.all(KINDS.map(kind => controller.catalog(`/v1/cadastros/taxonomias/${TAXONOMY_SLUG[kind]}`, { signal: request.signal }).then(value => [kind, taxonomyItems(value, kind)] as const)))
      .then(entries => { if (!request.signal.aborted) setTaxonomies(Object.fromEntries(entries)); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setTaxonomies({ failed: true }); });
    return () => request.abort();
  }, [controller]);
  // "Origem padrão de tributação de produtos" fills Origem of a new product; without the preference the field starts empty.
  useEffect(() => {
    if (settings !== null) return;
    const request = new AbortController();
    void Promise.resolve().then(() => loadProductSettings(controller, request.signal)).then(value => { if (!request.signal.aborted) setSettings({ origin: value.origin, sequential: value.sequentialCode, codeMode: value.codeMode, eanPrefixValid: value.eanPrefixValid, skipSteps: value.skipSteps }); })
      .catch(() => { if (!request.signal.aborted) setSettings({ ...EDIT_SETTINGS }); });
    return () => request.abort();
  }, [controller]);
  if (record && !complete) return <section className="real-editor catalog-editor" aria-labelledby="catalog-edit-title"><header className="real-editor-heading"><h2 id="catalog-edit-title">{record.name}</h2></header>
    {error ? <p className="real-alert" role="alert">{error}<button type="button" className="text-button" onClick={() => setAttempt(value => value + 1)}>Tentar novamente</button></p> : <p role="status">Carregando o cadastro completo…</p>}
    <div className="real-editor-actions"><button type="button" className="secondary-button" onClick={props.onClose}>Voltar</button></div></section>;
  if (settings === null || weightDecimals === null) return <section className="real-editor catalog-editor"><p role="status">Carregando o formulário…</p></section>;
  // "Pular etapas no cadastro de produtos" off: "Incluir cadastro" opens the wizard (a clone and an edit open the complete form).
  const wizard = !record && !props.initialValues && !settings.skipSteps;
  return <ProductForm {...props} record={complete} taxonomies={taxonomies} origin={settings.origin} sequential={settings.sequential} codeMode={settings.codeMode} eanPrefixValid={settings.eanPrefixValid}
    weightDecimals={weightDecimals} wizard={wizard} />;
}
type FormSettings = { origin: string; sequential: boolean; codeMode: ProductCodeMode; eanPrefixValid: boolean; skipSteps: boolean };
const EDIT_SETTINGS: FormSettings = { origin: '', sequential: false, codeMode: 'manual', eanPrefixValid: false, skipSteps: true };

// Assistente "Cadastrar novo produto" (Origin, com "Pular etapas no cadastro de produtos" desligado): as etapas do Origin sem a de
// Variações (o Brufap não usa variações). Mesmo estado, validação e gravação do formulário completo.
type WizardStep = 'basic' | 'characteristics' | 'images' | 'stock' | 'tax';
const WIZARD_STEPS: { key: WizardStep; label: string; optional: boolean }[] = [
  { key: 'basic', label: 'Dados básicos', optional: false }, { key: 'characteristics', label: 'Características', optional: true }, { key: 'images', label: 'Imagens', optional: true },
  { key: 'stock', label: 'Estoque', optional: true }, { key: 'tax', label: 'Tributação', optional: true },
];
const BASIC_KEYS = ['name', 'code', 'price', 'unit', 'format', 'kind', 'condition', 'active', 'category_id'];
const stepOf = (key: string): WizardStep => BASIC_KEYS.includes(key) || key.startsWith('custom-') ? 'basic' : (() => { const tab = tabOf(key); return tab === 'suppliers' ? 'stock' : tab ?? 'basic'; })();
// Leva H (PRD-109): Com variações exists now (the variations are added after the product is saved).
const WIZARD_FORMATS = [{ value: 'S', label: 'Simples' }, { value: 'V', label: 'Com variações' }, { value: 'E', label: 'Com composição (Kit ou união de vários itens)' }];
/** Formato no assistente (Origin: balão que explica os formatos): texto próprio do Brufap, sem os links de tutorial do Origin. */
function WizardFormatHelp() {
  const [open, setOpen] = useState(false);
  return <span className="product-format-help">
    <button type="button" className="text-button" aria-expanded={open} aria-controls="product-format-help" onClick={() => setOpen(value => !value)}><Icon name="circle-question" size={11} />Qual formato escolher?</button>
    {open && <span id="product-format-help" role="note" className="product-format-popover">
      <strong>Simples</strong>: um item único, sem grade de tamanhos ou cores.<br />
      <strong>Com variações</strong>: o mesmo produto em grade (tamanho, cor, voltagem). Ele só agrupa: depois de salvar, cada variação vira um produto com código, preço e estoque próprios, e é a variação que se vende.<br />
      <strong>Com composição</strong>: um kit ou a união de vários itens já cadastrados; os componentes e como o estoque é lançado ficam na aba Estrutura do formulário completo.
    </span>}</span>;
}
// Tributação > IPI (Origin): Classe de enquadramento, Valor IPI fixo e Código do selo aparecem no Regime Normal (CRT 3). Um valor
// já gravado continua visível; com o regime não confirmado ou ilegível, todos aparecem.
const IPI_CONDITIONAL = ['ipi_framework_class', 'ipi_fixed_value', 'ipi_seal_code'];
const NFE_TABLES = 'https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=%2FNJarYc9nus%3D';

/** Tributação > IPI: the confirmed regime of the company (migration 191), read when Tributação is first shown; 'unknown' while
 * loading or when it cannot be read (every IPI field is shown then). */
function useCompanyRegime(controller: CatalogEditorProps['controller'], wanted: boolean): string | null | 'unknown' {
  const [crt, setCrt] = useState<string | null | 'unknown'>('unknown'), [asked, setAsked] = useState(false);
  useEffect(() => { if (wanted) setAsked(true); }, [wanted]);
  useEffect(() => {
    if (!asked) return;
    const request = new AbortController();
    void Promise.resolve().then(() => controller.catalog('/v1/cadastros/products/contexto', { signal: request.signal })).then(value => {
      const found = (value as { crt?: unknown } | null)?.crt;
      if (!request.signal.aborted) setCrt(found === null ? null : typeof found === 'string' && /^[1-4]$/.test(found) ? found : 'unknown');
    }).catch(() => { if (!request.signal.aborted) setCrt('unknown'); });
    return () => request.abort();
  }, [controller, asked]);
  return crt;
}

function ProductForm(props: CatalogEditorProps & { taxonomies: Taxonomies; origin: string; sequential?: boolean; codeMode?: ProductCodeMode; eanPrefixValid?: boolean; weightDecimals?: number; wizard?: boolean }) {
  const { record, taxonomies, cloneOf, controller, writable } = props;
  const [tab, setTab] = useState<ProductTab>('characteristics');
  const [wizard, setWizard] = useState(Boolean(props.wizard)), [step, setStep] = useState<WizardStep>('basic');
  const crt = useCompanyRegime(controller, wizard ? step === 'tax' : tab === 'tax');
  // Imagens armazenadas: mounted when Imagens is first shown (each preview is a download of up to 2 MB) and kept mounted after,
  // so a pending upload or change survives a tab change.
  const [imagesSeen, setImagesSeen] = useState(false), imagesShown = wizard ? step === 'images' : tab === 'images';
  useEffect(() => { if (imagesShown) setImagesSeen(true); }, [imagesShown]);
  // Origin: changing steps without the Nome shows the orange alert with the pending items and highlights the field.
  const [stepAlert, setStepAlert] = useState<string[] | null>(null);
  const initial = useMemo(() => productFormValues(record, props.initialValues, { origin: props.origin, weightDecimals: props.weightDecimals }), []);
  const [lists, setLists] = useState<ProductLists>(() => productLists(record, props.initialValues));
  const [drawer, setDrawer] = useState<null | { kind: 'supplier'; index: number | null } | { kind: 'tags' }>(null);
  const deleted = typeof record?.deleted_at === 'string';
  // Campos customizados (migration 156): sent only once the definitions are read, so a failed read changes no stored value.
  const customFields = useCustomFields(controller);
  const [categoryChange, setCategoryChange] = useState<{ next: string; lost: CustomField[] } | null>(null);
  const [initialBalance, setInitialBalance] = useState<InitialBalanceDraft>(EMPTY_INITIAL_BALANCE);
  // Código do produto Sequencial EAN without the GS1 prefix: the server refuses a new product without code, so the form asks first.
  const eanWithoutPrefix = !record && props.codeMode === 'sequencial_ean' && !props.eanPrefixValid;
  const composition = useProductComposition(controller, record?.id ?? null, record?.version ?? null);
  const baseExtra = record ? lists : { lists, initialBalance: { ...initialBalance, warehouse: '' } };
  const editor = useCatalogEditor({ ...props, initialValues: initial }, {
    // The default warehouse alone saves nothing: only the typed fields of the saldo inicial count as unsaved changes.
    focusKey: wizard ? step : tab, extra: composition.dirty ? { base: baseExtra, composition: composition.key } : baseExtra, buildExtra: values => {
      checkWeights(values, initial, props.weightDecimals ?? 3);
      if (eanWithoutPrefix && !(values.code ?? '').trim()) invalidField('code', 'Informe o código (SKU): o código Sequencial EAN precisa do Prefixo GS1 da empresa em Preferências › Configurações de produtos.');
      // Origin: "Não é possível criar um produto com variações quando possuir um lote preenchido." (migration 191 refuses it too).
      if (values.lot_control === 'true' && values.format === 'V') invalidField('lot_control', 'Não é possível usar controle de lote em produto com variações. Desative o Controle de lote ou escolha outro formato.');
      // Itens p/ caixa (migration 191) travels in the detail payload as items_per_box_decimal.
      const detail = productDetailPayload(values, lists);
      const payload = Array.isArray(customFields) ? { ...detail, custom_values: customValuesPayload(visibleCustomFields(customFields, values.category_id, taxonomies.categories ?? []), lists.custom_values) } : detail;
      let structure: Record<string, unknown>;
      try { structure = compositionSavePayload(composition, values.format ?? '', !record); } catch (failure) { if (wizard) setWizard(false); setTab(STRUCTURE_TAB); throw failure; }
      return { ...(record || !initialBalanceAllowed(values) ? payload : { ...payload, ...initialBalancePayload(initialBalance, values.unit ?? '') }), ...structure };
    },
    savePath: id => id ? `/v1/cadastros/products/${id}/completo` : '/v1/cadastros/products/completo',
    onInvalid: field => { if (wizard) { setStep(stepOf(field)); return; } const target = tabOf(field); if (target) setTab(target); },
  });
  const { values, changeField } = editor;
  // Only Produtos tags belong to a product (migration 153); Contatos tags stay out of this form.
  const tags = ofTagType(taxonomies.tags ?? [], 'products'), tagGroups = ofTagType(taxonomies.tag_groups ?? [], 'products');
  const tabs = withStructure(values.format);
  useEffect(() => { if (values.format !== 'E' && tab === STRUCTURE_TAB) setTab('characteristics'); }, [values.format, tab]);
  const selectTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = (event.key === 'ArrowRight' || event.key === 'ArrowDown') ? (index + 1) % tabs.length : (event.key === 'ArrowLeft' || event.key === 'ArrowUp') ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
    if (next === null) return; event.preventDefault(); setTab(tabs[next].key); document.getElementById(`product-tab-${tabs[next].key}`)?.focus();
  };
  const changeLists = (change: (current: ProductLists) => ProductLists) => { setLists(change); editor.setWarnings(null); };
  const input = (key: string, locked: boolean, spec?: { label: string; max?: number; info?: string; placeholder?: string; options?: { value: string; label: string }[]; kind?: string; type?: string; required?: boolean; help?: ReactNode; empty?: string | false; counter?: boolean }) => {
    const base = spec ?? BASE[key] ?? (() => { const detail = DETAIL_FIELDS.find(field => field.key === key) as DetailField; return { label: detail.label, max: detail.max, info: detail.info, placeholder: detail.placeholder, options: detail.options, kind: detail.kind === 'textarea' ? 'textarea' : detail.kind === 'select' ? 'select' : detail.kind === 'date' ? 'date' : undefined }; })();
    const id = `catalog-${key}`, warned = key === 'name' && stepAlert !== null, invalid = editor.invalidField === key || warned, value = values[key] ?? '';
    const describedBy = [base.info ? `${id}-info` : null, editor.invalidField === key ? 'catalog-validation-error' : warned ? 'product-wizard-alert' : null].filter(Boolean).join(' ') || undefined;
    const common = { id, value: key === 'ncm' ? ncmMask(value) : value, disabled: locked, 'aria-invalid': invalid || undefined, 'aria-describedby': describedBy,
      onChange: (event: { target: { value: string } }) => { if (warned && event.target.value.trim()) setStepAlert(null); changeField(key, key === 'ncm' ? event.target.value.replace(/\D/g, '').slice(0, 8) : event.target.value); } };
    const options = key === 'kind' && value === 'N' ? [...(base.options ?? []), { value: 'N', label: 'Outro tipo cadastral (N)' }] : base.options;
    return <div className={`form-field${base.kind === 'textarea' ? ' real-field-wide' : ''}${warned ? ' product-field-warning' : ''}`} key={key}>
      <label htmlFor={id}>{base.label}{spec?.required || key === 'name' ? ' *' : ''}{base.info && <span className="product-info" title={base.info}><Icon name="circle-info" size={11} /></span>}</label>
      {base.kind === 'textarea' ? <textarea {...common} rows={4} maxLength={base.max} />
        : base.kind === 'select' ? <select {...common}>{(spec?.empty ?? (key === 'condition' || key === 'kind' || key === 'format' ? false : 'Selecione')) !== false && <option value="">{spec?.empty ?? 'Selecione'}</option>}{options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        : <input {...common} type={base.kind === 'date' ? 'date' : 'text'} min={base.kind === 'date' ? '1900-01-01' : undefined} max={base.kind === 'date' ? '2100-12-31' : undefined} placeholder={base.placeholder} maxLength={base.kind === 'date' ? undefined : base.max} autoComplete="off" required={key === 'name'} inputMode={key === 'items_per_box' ? 'decimal' : undefined} />}
      {base.info && <small id={`${id}-info`} className="real-sr-only">{base.info}</small>}
      {key === 'name' && <small className="product-counter" aria-live="polite">{value.length}/120</small>}
      {spec?.help}
    </div>;
  };
  const section = (title: string, children: ReactNode, open = true) => <details className="product-section" open={open}><summary>{title}<Icon name="chevron-down" size={11} /></summary><div className="real-editor-fields">{children}</div></details>;
  const firstImage = lists.images[0];
  // Wave E: without an external image, the first stored image is the Imagem principal (read once; the Imagens tab reports changes).
  const [tabMain, setTabMain] = useState<string | null | undefined>(undefined);
  const storedMain = useStoredMainImage(controller, record?.id ?? null, !firstImage && tabMain === undefined);
  const mainImage = firstImage ?? (tabMain === undefined ? storedMain : tabMain);
  const categories = taxonomies.categories ?? [], groups = taxonomies.product_groups ?? [];
  const tagName = (id: string) => tags.find(tag => tag.id === id)?.name ?? 'Tag excluída';
  const supplierRows = lists.suppliers;
  // Origin: "Ao alterar a categoria do produto, os campos customizados vinculados serão removidos."
  const changeCategory = (next: string) => {
    const lost = Array.isArray(customFields) ? lostCustomValues(customFields, lists.custom_values, values.category_id, next, categories) : [];
    if (lost.length) setCategoryChange({ next, lost }); else changeField('category_id', next);
  };
  const confirmCategory = () => {
    if (!categoryChange) return;
    changeField('category_id', categoryChange.next);
    changeLists(current => ({ ...current, custom_values: Object.fromEntries(Object.entries(current.custom_values).filter(([id]) => !categoryChange.lost.some(field => field.id === id))) }));
    setCategoryChange(null);
  };
  const shownCustomFields = Array.isArray(customFields) ? visibleCustomFields(customFields, values.category_id, categories) : [];
  // Listas de preço: read only when the section is opened, so opening the form makes no extra request.
  const [pricesOpen, setPricesOpen] = useState(false);
  const priceLists = usePriceLists(controller, pricesOpen ? record?.id ?? null : null);
  const codeSpec = !record && props.sequential ? { ...BASE.code, placeholder: 'Gerado ao salvar', info: props.codeMode === 'sequencial_ean' ? 'Código Sequencial EAN (Preferências > Configurações de produtos): deixe vazio e o próximo GTIN-13 com o prefixo GS1 da empresa é atribuído ao salvar.' : 'Código sequencial (Preferências > Configurações de produtos): deixe vazio e o próximo número é atribuído ao salvar.' }
    : eanWithoutPrefix ? { ...BASE.code, info: 'O código Sequencial EAN precisa do Prefixo GS1 da empresa (Preferências > Configurações de produtos). Sem ele, informe o código.' } : undefined;
  // A stored value keeps its field visible even while it is being cleared, so the field never disappears under the cursor.
  const ipiShown = (key: string) => !IPI_CONDITIONAL.includes(key) || crt === '3' || crt === 'unknown' || crt === null || Boolean(values[key]?.trim()) || Boolean(initial[key]?.trim());
  const ipiNote = crt === '1' || crt === '2' || crt === '4' ? 'Classe de enquadramento, Valor IPI fixo e Código do selo do IPI aparecem para empresas do Regime Normal (regime tributário em Preferências › Dados da empresa).'
    : crt === null ? 'O regime tributário da empresa não está confirmado: todos os campos do IPI aparecem.' : null;
  const categoryField = (locked: boolean) => <div className="form-field"><label htmlFor="catalog-category_id">Categoria<span className="product-info" title="Categoria referente aos campos customizados, sem vínculo com as integrações multiloja"><Icon name="circle-info" size={11} /></span></label>
    <div className="product-inline"><SearchableSelect id="catalog-category_id" value={values.category_id ?? ''} disabled={locked || taxonomies.failed} invalid={editor.invalidField === 'category_id'} options={treeOptions(categories, 'Sem categoria', values.category_id, taxonomies.categories ? 'Categoria excluída' : 'Carregando…')} onChange={event => changeCategory(event.target.value)} />
      <Link className="icon-button" to="/categorias-produtos" title="Gerenciar categorias de produto" aria-label="Gerenciar categorias de produto"><Icon name="gear" size={13} /></Link></div>
    {taxonomies.failed && <small>Não foi possível carregar as categorias e as tags. Elas continuam gravadas no produto.</small>}</div>;
  const customBlock = (locked: boolean) => <ProductCustomFields state={customFields} fields={shownCustomFields} values={lists.custom_values} locked={locked} invalidField={editor.invalidField}
    onChange={(id, value) => changeLists(current => ({ ...current, custom_values: { ...current.custom_values, [id]: value } }))} />;
  // Leva H (PRD-109, 410): the variations of a saved product with Formato V (a new product saves first, then gets its variations).
  const formatNotice = <>{values.format === 'V' && (record?.id ? <ProductVariations controller={controller} productId={record.id} writable={Boolean(writable)} />
    : <p className="real-notice">Salve o produto com Formato Com variações para adicionar as variações (cada uma é um produto com código, preço e estoque próprios).</p>)}
    {values.format === 'E' && <p className="real-notice">Composição: os componentes, o tipo de estoque (Físico ou Virtual) e como o estoque é lançado ficam na aba Estrutura.</p>}</>;
  // ---- Panels shared by the complete form (tabs) and the wizard (steps) ----
  const characteristics = (locked: boolean, withCategory: boolean) => <>
    {!values.dimension_unit && ['width', 'height', 'depth'].some(key => Boolean(values[key]?.trim())) && <p className="real-notice" role="status">Há medidas informadas sem unidade. Confira a unidade de medida; nenhuma unidade será presumida.</p>}
    <fieldset disabled={locked} className="real-editor-fields"><legend className="real-sr-only">Características</legend>
      {input('brand', locked)}{input('production', locked)}{input('expiry_date', locked)}{input('free_shipping', locked)}
      {input('net_weight', locked)}{input('gross_weight', locked)}{input('width', locked)}{input('height', locked)}{input('depth', locked)}
      {input('volumes', locked)}{input('items_per_box', locked)}{input('dimension_unit', locked)}{input('gtin', locked)}{input('gtin_tax', locked)}
      {input('discreet_description', locked)}
    </fieldset>
    {section('Código DUN', <div className="real-field-wide product-grid"><table className="data-table"><thead><tr><th scope="col">Código</th><th scope="col">Quantidade</th><th scope="col"><span className="real-sr-only">Ações</span></th></tr></thead>
      <tbody>{lists.dun_codes.map((item, index) => <tr key={index}><td><input aria-label={`Código DUN da linha ${index + 1}`} value={item.code} inputMode="numeric" maxLength={14} placeholder="Digite aqui" disabled={locked} onChange={event => changeLists(current => ({ ...current, dun_codes: current.dun_codes.map((row, i) => i === index ? { ...row, code: event.target.value.replace(/\D/g, '') } : row) }))} /></td>
        <td><input aria-label={`Quantidade do DUN da linha ${index + 1}`} value={item.quantity} inputMode="decimal" maxLength={19} placeholder="Digite aqui" disabled={locked} onChange={event => changeLists(current => ({ ...current, dun_codes: current.dun_codes.map((row, i) => i === index ? { ...row, quantity: event.target.value } : row) }))} /></td>
        <td><button type="button" className="icon-button" aria-label={`Remover o DUN da linha ${index + 1}`} title="Remover" disabled={locked} onClick={() => changeLists(current => ({ ...current, dun_codes: current.dun_codes.filter((_, i) => i !== index) }))}><Icon name="trash-can" size={12} /></button></td></tr>)}</tbody></table>
      <button type="button" id="catalog-dun_codes" className="text-button" disabled={locked || lists.dun_codes.length >= 10} onClick={() => changeLists(current => ({ ...current, dun_codes: [...current.dun_codes, { code: '', quantity: '' }] }))}><Icon name="plus" size={11} />Adicionar DUN</button></div>, lists.dun_codes.length > 0)}
    {/* Leva H (350): os campos do Origin, a origem e a data da sincronização, somente leitura. */}
    {record && (record.source || originHistoryAvailable(controller.getSnapshot().membership)) && <OriginMirrorPanel showOrigin={originHistoryAvailable(controller.getSnapshot().membership)} controller={props.controller} entity="products" id={record.id} writable={false} />}
    {record && <details className="product-section" onToggle={event => setPricesOpen((event.currentTarget as HTMLDetailsElement).open)}><summary>Listas de preço<Icon name="chevron-down" size={11} /></summary><div className="real-editor-fields"><div className="real-field-wide product-grid">{priceLists === null ? <p role="status">Consultando as listas de preço…</p> : priceLists === 'error' ? <p className="real-help">Não foi possível consultar as listas de preço deste produto.</p>
      : priceLists.length ? <table className="data-table"><thead><tr><th scope="col">Nome da lista</th><th scope="col">Tipo de lista</th><th scope="col" className="numeric">Preço do produto na lista</th><th scope="col">Regra aplicada</th></tr></thead>
        <tbody>{priceLists.map(item => <tr key={item.id}><td>{item.name}</td><td>{{ rates: 'Lista de taxas', period: 'Lista por período', custom: 'Lista customizada' }[item.list_type]}</td><td className="numeric">{item.list_price ? `R$ ${item.list_price.replace('.', ',')}` : '—'}</td><td>{item.rule}</td></tr>)}</tbody></table>
        : <p className="real-help">O produto não está em nenhuma lista de preços. <Link to="/listas-precos?nova=1">Incluir uma lista de preços</Link></p>}</div></div></details>}
    <fieldset disabled={locked} className="real-editor-fields"><legend className="real-sr-only">Descrições e vínculos</legend>
      {input('description', locked)}{input('complementary_description', locked)}{input('external_link', locked)}{input('video_url', locked)}{input('notes', locked)}
      <div className="form-field real-field-wide"><span className="product-field-label">Tags</span><div className="product-tags">{lists.tag_ids.length ? lists.tag_ids.map(id => <span key={id} className="product-tag">{tagName(id)}</span>) : <span className="real-help">Nenhuma tag</span>}
        <button type="button" id="catalog-tag_ids" className="text-button" disabled={locked || taxonomies.failed} onClick={() => setDrawer({ kind: 'tags' })}><Icon name="tags" size={11} />Editar tags</button></div></div>
      {withCategory && categoryField(locked)}
    </fieldset>
    {withCategory && customBlock(locked)}
  </>;
  const images = (locked: boolean) => <>{(imagesSeen || imagesShown) && <ProductStoredImages controller={controller} productId={record?.id ?? null} writable={writable && !deleted} onFirst={setTabMain} />}
    <ExternalImages images={lists.images} locked={locked} invalid={editor.invalidField === 'images'} onChange={next => changeLists(current => ({ ...current, images: next }))} /></>;
  // Estoque > Controle de lote (Origin): the switch is stored with the product; the lots (grid below, "+ Adicionar lote") and the
  // balance per lot belong to the stock area (258) and are saved by their own stock commands, never by the product save.
  // With variations the switch cannot be turned on; one already on stays switchable off and the save asks for it.
  const lotOn = values.lot_control === 'true', lotVariations = values.format === 'V', lotBlocked = lotVariations && !lotOn;
  const stock = (locked: boolean) => <>
    <fieldset disabled={locked} className="real-editor-fields"><legend className="real-sr-only">Estoque</legend>{input('stock_min', locked)}{input('stock_max', locked)}{input('crossdocking_days', locked)}{input('location', locked)}
      <div className="form-field real-field-wide product-active"><span className="product-active-label">Controle de lote</span><label className="product-switch"><input type="checkbox" id="catalog-lot_control" role="switch" checked={lotOn} disabled={locked || lotBlocked}
        aria-invalid={editor.invalidField === 'lot_control' || undefined} aria-describedby={editor.invalidField === 'lot_control' ? 'catalog-lot_control-help catalog-validation-error' : 'catalog-lot_control-help'}
        onChange={event => changeField('lot_control', String(event.target.checked))} /><span>{lotOn ? 'Controle de lote ativado' : 'Controle de lote desativado'}</span></label>
        <small id="catalog-lot_control-help" className="real-help">{lotVariations ? 'Não é possível usar controle de lote em produto com variações.' : 'A chave fica gravada no produto. Com o controle ativado e salvo, os lotes ficam abaixo e em Estoque › Lançamentos de estoque (aba Lotes e validades), e o Novo Lançamento e as transferências aceitam o Lote. Pedidos, OS e notas lançam sem lote.'}</small></div>
      <ProductLots controller={controller} productId={record?.id ?? null} lotOn={lotOn} savedLotOn={record?.lot_control === true} writable={writable && !deleted} unit={values.unit} /></fieldset>
    {!record && initialBalanceAllowed(values) && <StockInitialBalanceFields controller={controller} value={initialBalance} onChange={setInitialBalance} disabled={locked} unit={values.unit} />}
    <p className="real-help">As quantidades usam a unidade do produto ({values.unit || 'não informada'}). Para gerenciar o estoque acesse o módulo de {record ? <Link to={`/estoque-empresa?produto=${record.id}`}>Controle de Estoques</Link> : <Link to="/estoque-empresa">Controle de Estoques</Link>}.</p>
  </>;
  const suppliers = (locked: boolean) => <>
    <div className="product-grid"><table className="data-table"><thead><tr><th scope="col">nº</th><th scope="col">Fornecedor</th><th scope="col">Descrição no fornecedor</th><th scope="col">Código no fornecedor</th><th scope="col" className="numeric">Preço de custo</th><th scope="col">Padrão</th><th scope="col"><span className="real-sr-only">Ações</span></th></tr></thead>
      <tbody>{supplierRows.length ? supplierRows.map((item, index) => <tr key={item.supplier_id}><td>{index + 1}</td><td>{item.supplier_name}</td><td>{item.description || '—'}</td><td>{item.code || '—'}</td><td className="numeric">{item.cost_price || '—'}</td>
        <td><input type="radio" name="product-supplier-default" aria-label={`Fornecedor padrão: ${item.supplier_name}`} checked={item.is_default} disabled={locked} onChange={() => changeLists(current => ({ ...current, suppliers: current.suppliers.map((row, i) => ({ ...row, is_default: i === index })) }))} /></td>
        <td className="product-row-actions"><button type="button" className="icon-button" aria-label={`Editar o fornecedor ${item.supplier_name}`} title="Editar" disabled={locked} onClick={() => setDrawer({ kind: 'supplier', index })}><Icon name="pen-to-square" size={12} /></button>
          <button type="button" className="icon-button" aria-label={`Remover o fornecedor ${item.supplier_name}`} title="Remover" disabled={locked} onClick={() => changeLists(current => { const next = current.suppliers.filter((_, i) => i !== index); if (next.length && !next.some(row => row.is_default)) next[0] = { ...next[0], is_default: true }; return { ...current, suppliers: next }; })}><Icon name="trash-can" size={12} /></button></td></tr>)
        : <tr><td colSpan={7} className="real-help">Nenhum fornecedor vinculado.</td></tr>}</tbody></table>
      <button type="button" id="catalog-suppliers" className="text-button" disabled={locked || supplierRows.length >= 20} onClick={() => setDrawer({ kind: 'supplier', index: null })}><Icon name="plus" size={11} />{wizard ? 'Adicione um Fornecedor' : 'Adicionar fornecedor'}</button></div>
    <p className="real-help">O preço de custo do fornecedor padrão é o “Preço de Custo” do produto na listagem.</p>
  </>;
  const tax = (locked: boolean) => <>
    <div className="product-banner"><strong>Dados da nota fiscal</strong> — Preencha somente se for emitir nota fiscal. Estes dados ainda não calculam impostos nem definem automaticamente CFOP, CST ou CSOSN.</div>
    <fieldset disabled={locked} className="real-editor-fields"><legend className="real-sr-only">Tributação</legend>
      {input('origin', locked)}{(FCI_ORIGINS.includes(values.origin) || Boolean(values.fci_number)) && input('fci_number', locked)}
      {input('ncm', locked)}{input('cest', locked, { ...BASE.cest, help: <a className="product-external" href="https://www.confaz.fazenda.gov.br/legislacao/convenios/2018/CV142_18" target="_blank" rel="noreferrer noopener">Consultar</a> })}
      {input('item_type', locked)}{input('tax_percent', locked)}
      <div className="form-field"><label htmlFor="catalog-product_group_id">Grupo de Produtos</label><div className="product-inline"><SearchableSelect id="catalog-product_group_id" value={values.product_group_id ?? ''} disabled={locked || taxonomies.failed} options={treeOptions(groups, 'Selecione', values.product_group_id, taxonomies.product_groups ? 'Grupo excluído' : 'Carregando…')} onChange={event => changeField('product_group_id', event.target.value)} />
        <Link className="text-button" to="/grupos-produtos">Gerenciar grupos</Link></div></div>
    </fieldset>
    {['ICMS', 'IPI', 'PIS / COFINS', 'Combustível', 'GLP'].map(group => <div key={group}>{section(group, <>
      {DETAIL_FIELDS.filter(field => field.group === group && ipiShown(field.key)).map(field => field.key === 'ipi_framework_class'
        ? input(field.key, locked, { label: field.label, max: field.max, info: field.info, help: <a className="product-external" href={NFE_TABLES} target="_blank" rel="noreferrer noopener" title="Tabelas oficiais da NF-e (código de enquadramento legal do IPI)">Consultar</a> }) : input(field.key, locked))}
      {group === 'IPI' && ipiNote && <p className="real-help real-field-wide">{ipiNote}</p>}</>, DETAIL_FIELDS.some(field => field.group === group && Boolean(values[field.key])))}</div>)}
    {section('Dados adicionais', input('additional_info', locked), Boolean(values.additional_info))}
  </>;
  const basicFields = (locked: boolean) => <fieldset disabled={locked} className="real-editor-fields product-basic-fields"><legend>Dados básicos</legend>
    {input('name', locked)}{input('code', locked, codeSpec)}{wizard ? <>{input('price', locked, { ...BASE.price, info: 'Valor que será cobrado ao cliente pelo produto.' })}{input('unit', locked, { ...BASE.unit, info: 'Unidade de medida do produto. Ex.: kg, un, etc.' })}
      {input('format', locked, { ...BASE.format, options: values.format === 'V' ? [...WIZARD_FORMATS, { value: 'V', label: 'Com variações' }] : WIZARD_FORMATS, help: <WizardFormatHelp /> })}{input('kind', locked)}{input('condition', locked, { ...BASE.condition, info: 'Especifique a condição do produto. Ex.: novo ou usado.' })}</>
      : <>{input('format', locked)}{input('kind', locked)}
        <div className="form-field product-active"><span className="product-active-label">Situação</span><label className="product-switch"><input type="checkbox" id="catalog-active" role="switch" checked={values.active !== 'false'} disabled={locked} onChange={event => changeField('active', String(event.target.checked))} /><span>{values.active !== 'false' ? 'Ativado' : 'Desativado'}</span></label></div>
        {input('price', locked)}{input('unit', locked)}{input('condition', locked)}</>}
    {wizard && categoryField(locked)}
  </fieldset>;
  const drawers = <>
    {drawer?.kind === 'supplier' && <SupplierDrawer controller={controller} current={drawer.index === null ? null : lists.suppliers[drawer.index]} taken={lists.suppliers.map(item => item.supplier_id).filter((_, i) => i !== drawer.index)}
      onCancel={() => setDrawer(null)} onApply={supplier => { changeLists(current => {
        const next = drawer.index === null ? [...current.suppliers, { ...supplier, is_default: current.suppliers.length === 0 }] : current.suppliers.map((row, i) => i === drawer.index ? { ...supplier, is_default: row.is_default } : row);
        return { ...current, suppliers: next };
      }); setDrawer(null); }} />}
    {categoryChange && <Modal title="Alterar categoria" onClose={() => setCategoryChange(null)} actions={<><button type="button" className="secondary-button" onClick={() => setCategoryChange(null)}>Cancelar</button><button type="button" className="primary-button" onClick={confirmCategory}>Alterar categoria</button></>}>
      <p>Ao alterar a categoria do produto, os campos customizados vinculados serão removidos.</p>
      <ul>{categoryChange.lost.map(field => <li key={field.id}>{field.name}</li>)}</ul>
      <p className="real-help">Nada é gravado até você clicar em Salvar produto.</p></Modal>}
    {drawer?.kind === 'tags' && <TagsDrawer controller={controller} writable={writable} tags={tags} groups={tagGroups} selected={lists.tag_ids} onCancel={() => setDrawer(null)}
      onApply={ids => { changeLists(current => ({ ...current, tag_ids: ids })); setDrawer(null); }} />}
  </>;
  const form = (locked: boolean) => <div className="product-editor-fields">
    <div className="product-basic">
      <button type="button" className="product-main-image" onClick={() => setTab('images')} title="Imagem principal" aria-label="Imagem principal: abrir a aba Imagens">
        {mainImage ? <img src={mainImage} alt="" referrerPolicy="no-referrer" /> : <Icon name="image" size={34} />}</button>
      {basicFields(locked)}
    </div>
    {formatNotice}
    <div className="fagoo-product-workspace"><aside className="fagoo-product-outline"><p className="fagoo-eyebrow">ORGANIZAR PRODUTO</p><div className="product-tabs" role="tablist" aria-orientation="vertical" aria-label="Detalhes do produto">{tabs.map((item, index) => <button key={item.key} type="button" role="tab" id={`product-tab-${item.key}`} aria-selected={tab === item.key} aria-controls={`product-panel-${item.key}`} tabIndex={tab === item.key ? 0 : -1} onClick={() => setTab(item.key)} onKeyDown={event => selectTab(event, index)}>{item.label}</button>)}</div>{writable && !locked && <ProductValidationPanel values={values} sequential={Boolean(props.sequential && !record)} onEdit={key => document.getElementById(`catalog-${key}`)?.focus()} />}</aside><div className="fagoo-product-panels">
    <section id="product-panel-characteristics" role="tabpanel" aria-labelledby="product-tab-characteristics" hidden={tab !== 'characteristics'} className="product-tab-panel">{characteristics(locked, true)}</section>
    <section id="product-panel-images" role="tabpanel" aria-labelledby="product-tab-images" hidden={tab !== 'images'} className="product-tab-panel">{images(locked)}</section>
    <section id="product-panel-stock" role="tabpanel" aria-labelledby="product-tab-stock" hidden={tab !== 'stock'} className="product-tab-panel">{stock(locked)}</section>
    <section id="product-panel-structure" role="tabpanel" aria-labelledby="product-tab-structure" hidden={tab !== STRUCTURE_TAB} className="product-tab-panel">
      {values.format === 'E' && <ProductStructurePanel controller={controller} state={composition} productId={record?.id ?? null} locked={locked} invalid={editor.invalidField === 'composition'} />}
    </section>
    <section id="product-panel-suppliers" role="tabpanel" aria-labelledby="product-tab-suppliers" hidden={tab !== 'suppliers'} className="product-tab-panel">{suppliers(locked)}</section>
    <section id="product-panel-tax" role="tabpanel" aria-labelledby="product-tab-tax" hidden={tab !== 'tax'} className="product-tab-panel">{tax(locked)}</section></div></div>
    {drawers}
  </div>;
  // ---- Wizard ----
  const stepIndex = WIZARD_STEPS.findIndex(item => item.key === step);
  const goTo = (next: WizardStep) => {
    if (next === step) return;
    // Origin: no step change without the Nome; the alert lists what is missing and the field is highlighted and focused.
    if (!(values.name ?? '').trim()) { setStepAlert(['Preencha o nome do produto']); document.getElementById('catalog-name')?.focus(); return; }
    setStepAlert(null); setStep(next);
  };
  const wizardForm = (locked: boolean) => <div className="product-editor-fields product-wizard">
    <nav className="product-wizard-steps" aria-label="Etapas do cadastro"><ol>{WIZARD_STEPS.map((item, index) => <li key={item.key}>
      <button type="button" id={`product-step-${item.key}`} aria-current={step === item.key ? 'step' : undefined} className={index < stepIndex ? 'is-done' : undefined} onClick={() => goTo(item.key)}>
        <span className="product-wizard-number" aria-hidden="true">{index + 1}</span><span>{item.label}{item.optional && <small> (opcional)</small>}</span></button></li>)}</ol></nav>
    {/* Narrow screens: the circular progress of the Origin mobile wizard replaces the step column. */}
    <div className="product-wizard-progress" role="progressbar" aria-valuemin={1} aria-valuemax={WIZARD_STEPS.length} aria-valuenow={stepIndex + 1} aria-valuetext={`Etapa ${stepIndex + 1} de ${WIZARD_STEPS.length}: ${WIZARD_STEPS[stepIndex].label}`}
      style={{ ['--product-wizard-progress' as string]: `${Math.round(((stepIndex + 1) / WIZARD_STEPS.length) * 360)}deg` }}>
      <span className="product-wizard-circle" aria-hidden="true">{stepIndex + 1}/{WIZARD_STEPS.length}</span><span>Etapa {stepIndex + 1} de {WIZARD_STEPS.length}: <strong>{WIZARD_STEPS[stepIndex].label}</strong></span></div>
    <div className="product-wizard-body">
      {stepAlert && <div className="product-wizard-alert" id="product-wizard-alert" role="alert"><strong>Não foi possível navegar para o passo desejado</strong><p>Verifique os campos destacados abaixo.</p><ul>{stepAlert.map(item => <li key={item}>{item}</li>)}</ul></div>}
      <h3 className="product-wizard-title">{WIZARD_STEPS[stepIndex].label}</h3>
      {step === 'basic' && <>{basicFields(locked)}{formatNotice}{customBlock(locked)}</>}
      {step === 'characteristics' && characteristics(locked, false)}
      {step === 'images' && images(locked)}
      {step === 'stock' && <>{stock(locked)}<h4 className="product-wizard-subtitle">Fornecedores</h4>{suppliers(locked)}</>}
      {step === 'tax' && tax(locked)}
      <div className="real-editor-actions product-wizard-actions">
        <button type="button" className="text-button" disabled={locked} onClick={() => { setStepAlert(null); setTab(step === 'basic' ? 'characteristics' : step === 'stock' ? 'stock' : step); setWizard(false); }}>Pular para versão completa</button>
        <span className="product-wizard-spacer" />
        {stepIndex === 0 ? <button type="button" className="secondary-button" onClick={() => editor.guard.confirmLeave(props.onClose)}>Cancelar</button>
          : <button type="button" className="secondary-button" disabled={locked} onClick={() => goTo(WIZARD_STEPS[stepIndex - 1].key)}>Voltar</button>}
        {stepIndex < WIZARD_STEPS.length - 1 && <button type="button" className={stepIndex === 0 ? 'primary-button' : 'secondary-button'} disabled={locked} onClick={() => goTo(WIZARD_STEPS[stepIndex + 1].key)}>Avançar</button>}
        {stepIndex > 0 && writable && <button type="submit" className="primary-button" disabled={locked}>Salvar</button>}
      </div>
    </div>
    {drawers}
  </div>;
  return catalogEditorView(editor, props, {
    title: wizard ? 'Cadastrar novo produto' : record ? record.name : 'Produto', saveLabel: 'Salvar produto', editableInactive: true, readOnly: deleted, situationButton: false,
    notice: <>{cloneOf && <p className="real-notice" role="status">Cópia de “{cloneOf}”. O código (SKU), o GTIN/EAN, o GTIN/EAN tributário e os códigos DUN ficaram em branco para o novo produto. Nada é gravado até você clicar em Salvar produto.</p>}
      {deleted && <p className="real-notice" role="status">Produto excluído. Para editá-lo, restaure-o na listagem com a Situação “Excluídos”.</p>}</>,
    form: wizard ? wizardForm : form,
  });
}

type ProductPriceList = { id: string; name: string; list_type: 'rates' | 'period' | 'custom'; rule: string; list_price: string | null };
/** Listas de preço do produto (migração 121), só leitura; uma falha não impede o formulário. */
function usePriceLists(controller: CatalogEditorProps['controller'], id: string | null): ProductPriceList[] | null | 'error' {
  const [value, setValue] = useState<ProductPriceList[] | null | 'error'>(null);
  useEffect(() => {
    if (!id) return;
    const request = new AbortController();
    void Promise.resolve().then(() => controller.catalog(`/v1/cadastros/products/${id}/listas-precos`, { signal: request.signal })).then(result => {
      const items = (result as { product_id?: string; items?: ProductPriceList[] }).items;
      if (!request.signal.aborted) setValue((result as { product_id?: string }).product_id === id && Array.isArray(items) ? items : 'error');
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) setValue('error'); });
    return () => request.abort();
  }, [controller, id]);
  return value;
}

const parsedUrl = (value: string) => { try { const url = new URL(value); return url.protocol === 'https:' ? url : null; } catch { return null; } };
/** Imagens externas: URL HTTPS pública; dimensão, extensão e situação vêm do carregamento da imagem neste navegador. */
function ExternalImages({ images, locked, invalid, onChange }: { images: string[]; locked: boolean; invalid: boolean; onChange: (images: string[]) => void }) {
  const [draft, setDraft] = useState(''), [message, setMessage] = useState('');
  const [status, setStatus] = useState<Record<string, { state: 'ok' | 'error'; size?: string }>>({});
  const [dragging, setDragging] = useState<number | null>(null);
  const add = () => {
    const url = draft.trim();
    if (!/^https:\/\/[^\s]+$/.test(url) || url.length > 1000 || !parsedUrl(url)) { setMessage('Informe um endereço HTTPS público, sem espaços.'); return; }
    if (images.includes(url)) { setMessage('Esta imagem já está na lista.'); return; }
    if (images.length >= 20) { setMessage('O produto pode ter até 20 imagens externas.'); return; }
    onChange([...images, url]); setDraft(''); setMessage('');
  };
  const move = (from: number, to: number) => { if (from === to || to < 0 || to >= images.length) return; const next = [...images]; const [item] = next.splice(from, 1); next.splice(to, 0, item); onChange(next); };
  // A stored address can pass the server pattern and still not parse (e.g. "https://[x"): the row shows "—" instead of failing.
  const extension = (url: string) => /\.([a-z0-9]{2,5})(?:[?#].*)?$/i.exec(parsedUrl(url)?.pathname ?? '')?.[1]?.toLowerCase() ?? '—';
  return <div className="product-images">
    <h3>Imagens externas</h3>
    <p className="real-help">Endereços HTTPS públicos, na ordem em que aparecem (a primeira é a imagem principal do cadastro e a miniatura da listagem). Sem imagem externa, a primeira imagem armazenada é a imagem principal do cadastro; a miniatura da listagem usa só as imagens externas.</p>
    <div className="product-grid"><table className="data-table"><thead><tr><th scope="col"><span className="real-sr-only">Ordem</span></th><th scope="col">URL da imagem</th><th scope="col">Dimensão</th><th scope="col">Extensão</th><th scope="col">Prévia</th><th scope="col"><span className="real-sr-only">Ações</span></th></tr></thead>
      <tbody>{images.length ? images.map((url, index) => { const state = status[url]; return <tr key={url} draggable={!locked} onDragStart={() => setDragging(index)} onDragOver={event => event.preventDefault()} onDrop={() => { if (dragging !== null && !locked) move(dragging, index); setDragging(null); }}>
        <td className="product-order"><Icon name="grip-vertical" size={11} /><button type="button" className="icon-button" aria-label={`Mover a imagem ${index + 1} para cima`} disabled={locked || index === 0} onClick={() => move(index, index - 1)}><Icon name="arrow-up" size={10} /></button><button type="button" className="icon-button" aria-label={`Mover a imagem ${index + 1} para baixo`} disabled={locked || index === images.length - 1} onClick={() => move(index, index + 1)}><Icon name="arrow-down" size={10} /></button></td>
        <td className="product-url">{url}<small className={state?.state === 'error' ? 'is-error' : 'is-ok'}>{!state ? 'Verificando URL…' : state.state === 'ok' ? 'URL válida' : 'URL com problemas'}</small></td>
        <td>{state?.size ?? '—'}</td><td>{extension(url)}</td>
        <td><img className="product-thumb" src={url} alt={`Prévia da imagem ${index + 1}`} referrerPolicy="no-referrer" loading="lazy" onLoad={event => { const image = event.currentTarget; setStatus(current => ({ ...current, [url]: { state: 'ok', size: `${image.naturalWidth}x${image.naturalHeight}` } })); }} onError={() => setStatus(current => ({ ...current, [url]: { state: 'error' } }))} /></td>
        <td><button type="button" className="icon-button" aria-label={`Remover a imagem ${index + 1}`} title="Remover" disabled={locked} onClick={() => onChange(images.filter(item => item !== url))}><Icon name="trash-can" size={12} /></button></td></tr>; })
        : <tr><td colSpan={6} className="real-help">Nenhuma imagem externa.</td></tr>}</tbody></table></div>
    <div className="product-inline"><label className="real-sr-only" htmlFor="catalog-images">URL da nova imagem externa</label><input id="catalog-images" value={draft} placeholder="https://" maxLength={1000} disabled={locked} aria-invalid={invalid || undefined} onChange={event => { setDraft(event.target.value); setMessage(''); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
      <button type="button" className="secondary-button" disabled={locked || !draft.trim()} onClick={add}><Icon name="plus" size={11} />Adicionar nova imagem externa</button></div>
    {message && <p className="real-alert" role="alert">{message}</p>}
  </div>;
}

type ContactOption = { id: string; name: string; code: string | null };
/** Gaveta "Editar fornecedor do produto": fornecedor (pesquisa de contatos), descrição, código, preços e garantia. */
function SupplierDrawer({ controller, current, taken, onCancel, onApply }: { controller: CatalogEditorProps['controller']; current: ProductSupplier | null; taken: string[]; onCancel: () => void; onApply: (supplier: ProductSupplier) => void }) {
  const [value, setValue] = useState<ProductSupplier>(current ?? { supplier_id: '', supplier_name: '', supplier_code: null, description: '', code: '', purchase_price: '', cost_price: '', warranty_months: '', is_default: false });
  const [query, setQuery] = useState(current?.supplier_name ?? ''), [options, setOptions] = useState<ContactOption[]>([]), [searching, setSearching] = useState(false), [error, setError] = useState('');
  const request = useRef<AbortController | null>(null), search = useRef<HTMLInputElement | null>(null);
  // Origin: the contact's observations in a balloon and its persons of contact (Clientes e fornecedores, lane contatos).
  const [contactInfo, setContactInfo] = useState<{ id: string; notes: string | null; persons: { id: string; name: string }[] } | null>(null), [personsOpen, setPersonsOpen] = useState(false);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!value.supplier_id) { setContactInfo(null); return; }
    const signal = new AbortController(); setPersonsOpen(false);
    void Promise.resolve().then(() => controller.catalog(`/v1/cadastros/contatos/${value.supplier_id}`, { signal: signal.signal })).then(result => {
      const record = (result as { record?: { id?: string; notes?: unknown; persons?: unknown } }).record;
      if (signal.signal.aborted || record?.id !== value.supplier_id) return;
      setContactInfo({ id: record.id, notes: typeof record.notes === 'string' && record.notes.trim() ? record.notes : null,
        persons: Array.isArray(record.persons) ? (record.persons as { id?: unknown; name?: unknown }[]).filter(person => typeof person?.id === 'string' && typeof person.name === 'string').map(person => ({ id: person.id as string, name: person.name as string })) : [] });
    }).catch(() => { if (!signal.signal.aborted) setContactInfo(null); });
    return () => signal.abort();
  }, [controller, value.supplier_id]);
  useEffect(() => {
    if (!query.trim() || query === value.supplier_name) { setOptions([]); return; }
    const timer = setTimeout(() => {
      request.current?.abort(); const controllerSignal = new AbortController(); request.current = controllerSignal; setSearching(true);
      // Active contacts through the contacts picker (seller scope, wave C). No papel filter: contacts mirrored from Origin
      // carry no Tipo de contato yet, so "Fornecedor" would hide every supplier that came from Origin.
      void controller.catalog(`/v1/cadastros/contatos/opcoes?${new URLSearchParams({ limit: '25', q: query.trim() })}`, { signal: controllerSignal.signal }).then(result => {
        if (controllerSignal.signal.aborted) return;
        const items = (result as { items?: ContactOption[] }).items;
        setOptions(Array.isArray(items) ? items.filter(item => typeof item?.id === 'string' && typeof item.name === 'string').map(item => ({ id: item.id, name: item.name, code: item.code ?? null })) : []);
      }).catch(failure => { if (!controllerSignal.signal.aborted && !aborted(failure)) setError('Não foi possível pesquisar os contatos. Tente novamente.'); })
        .finally(() => { if (request.current === controllerSignal) setSearching(false); });
    }, 250);
    return () => clearTimeout(timer);
  }, [controller, query, value.supplier_name]);
  const apply = () => {
    if (!value.supplier_id) { setError('Selecione o fornecedor.'); return; }
    if (taken.includes(value.supplier_id)) { setError('Este fornecedor já está vinculado ao produto.'); return; }
    if (value.warranty_months && !/^(0|[1-9]\d{0,2})$/.test(value.warranty_months)) { setError('Informe a garantia em meses, até 999.'); return; }
    onApply(value);
  };
  const set = (key: keyof ProductSupplier, text: string) => setValue(previous => ({ ...previous, [key]: text }));
  return <Modal title="Editar fornecedor do produto" onClose={onCancel} actions={<><button type="button" className="secondary-button" onClick={onCancel}>Cancelar</button><button type="button" className="primary-button" onClick={apply}>Ok</button></>}>
    <div className="real-editor-fields product-drawer">
      <div className="form-field real-field-wide"><label htmlFor="product-supplier-search">Fornecedor *</label><input id="product-supplier-search" ref={search} value={query} autoComplete="off" placeholder="Pesquise pelo nome, código ou CPF/CNPJ" maxLength={120} onChange={event => { setQuery(event.target.value); setValue(previous => ({ ...previous, supplier_id: '', supplier_name: '' })); setError(''); }} />
        {searching && <small role="status">Pesquisando…</small>}
        {options.length > 0 && <ul className="product-options" role="listbox" aria-label="Contatos encontrados">{options.map(option => <li key={option.id}><button type="button" role="option" aria-selected={value.supplier_id === option.id} onClick={() => { setValue(previous => ({ ...previous, supplier_id: option.id, supplier_name: option.name, supplier_code: option.code })); setQuery(option.name); setOptions([]); setError(''); }}>{option.name}{option.code ? ` (${option.code})` : ''}</button></li>)}</ul>}
        {value.supplier_id && <span className="product-inline product-supplier-icons">
          <button type="button" className="icon-button" title="Visualizar pessoas de contato" aria-label="Visualizar pessoas de contato" aria-expanded={personsOpen} disabled={!contactInfo} onClick={() => setPersonsOpen(!personsOpen)}><Icon name="users" size={12} /></button>
          <button type="button" className="icon-button" title="Pesquisar" aria-label="Pesquisar outro fornecedor" onClick={() => search.current?.focus?.()}><Icon name="magnifying-glass" size={12} /></button>
          <Link className="icon-button" to={`/cadastros-reais?cadastro=contacts&registro=${value.supplier_id}`} target="_blank" rel="noopener" title="Editar Contato" aria-label="Editar Contato (nova aba)"><Icon name="pen-to-square" size={12} /></Link></span>}
        {personsOpen && contactInfo && <small>{contactInfo.persons.length ? `Pessoas de contato: ${contactInfo.persons.map(person => person.name).join(', ')}` : 'Nenhuma pessoa de contato.'}</small>}
        {contactInfo?.notes && <p className="product-supplier-notes" role="note"><strong>Observações do contato:</strong> {contactInfo.notes}</p>}</div>
      <div className="form-field"><label htmlFor="product-supplier-description">Descrição</label><input id="product-supplier-description" value={value.description} maxLength={120} onChange={event => set('description', event.target.value)} /></div>
      <div className="form-field"><label htmlFor="product-supplier-code">Código</label><input id="product-supplier-code" value={value.code} maxLength={60} onChange={event => set('code', event.target.value)} /></div>
      <div className="form-field"><label htmlFor="product-supplier-purchase">Preço de compra<span className="product-info" title="Valor de compra do produto"><Icon name="circle-info" size={11} /></span></label><input id="product-supplier-purchase" value={value.purchase_price} inputMode="decimal" maxLength={80} onChange={event => set('purchase_price', event.target.value)} /></div>
      <div className="form-field"><label htmlFor="product-supplier-cost">Preço de custo<span className="product-info" title="Valor de compra do produto com rateio de frete, descontos e impostos"><Icon name="circle-info" size={11} /></span></label><input id="product-supplier-cost" value={value.cost_price} inputMode="decimal" maxLength={80} onChange={event => set('cost_price', event.target.value)} /></div>
      <div className="form-field"><label htmlFor="product-supplier-warranty">Garantia (meses)</label><input id="product-supplier-warranty" value={value.warranty_months} inputMode="numeric" maxLength={3} onChange={event => set('warranty_months', event.target.value.replace(/\D/g, ''))} /></div>
    </div>
    {error && <p className="real-alert" role="alert">{error}</p>}
  </Modal>;
}

// Gaveta Tags: TagsDrawer.tsx (also used by the product list and the contacts, with the Tipo of the tags).
export { TagsDrawer };
export { taxonomyPath, EMPTY_LISTS };
