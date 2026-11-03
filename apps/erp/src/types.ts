export type NavigationGroup = 'Meu Negócio' | 'Cadastros' | 'Vendas' | 'Estoque' | 'Financeiro';

export type DemoRecord = { id: string; [key: string]: string | number | boolean | undefined };

export interface ColumnDefinition {
  key: string;
  label: string;
  type?: 'text' | 'money' | 'date' | 'status' | 'number';
  width?: string;
  /** Money shown green when positive and red when negative (Caixas e bancos). */
  signed?: boolean;
}

export interface FieldDefinition {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'money' | 'date' | 'select' | 'textarea';
  required?: boolean;
  options?: string[];
  section?: string;
}

export interface FilterDefinition {
  key: string;
  label: string;
  options: string[];
  /** 'text' matches by "contains"; 'multi' accepts several values separated by "|" (Origin's tag multiselect). */
  kind?: 'select' | 'text' | 'multi';
  info?: string;
  /** Filters driven by the title selector (e.g. "Todas as contas") stay out of the Filtrar panel. */
  hidden?: boolean;
}

export interface RowActionDefinition { label: string; icon?: string; letter?: { text: string; color: string }; separatorBefore?: boolean }
export interface PanelActionDefinition { label: string; icon: string; title?: string }

export interface ModuleDefinition {
  id: string;
  title: string;
  group: NavigationGroup;
  description?: string;
  searchPlaceholder?: string;
  searchKeys?: string[];
  listTabs?: { key: string; options: string[] };
  primaryAction?: string;
  columns: ColumnDefinition[];
  fields: FieldDefinition[];
  filters?: FilterDefinition[];
  dateField?: string;
  actions?: string[];
  readOnly?: boolean;
  /** Origin list chrome (docs/references/origin-interface.md). */
  selector?: { label: string; options: string[]; filterKey?: string };
  periodTypes?: string[];
  periodPrefix?: boolean;
  panelActions?: PanelActionDefinition[];
  moreActions?: { title: string; items: string[] }[];
  rowMenu?: RowActionDefinition[];
  info?: { count: string; total?: boolean };
  supportLinks?: { label: string; to?: string }[];
  indicatorKey?: string;
  situationStyle?: 'badge' | 'dot';
  filterPanelOpen?: boolean;
  selections?: string[];
  defaultFilters?: Record<string, string>;
  tabsAboveList?: boolean;
  /** Singular title used by the form ("Pedido de venda - 1001"). */
  formTitle?: string;
  /** Origin opens finance titles in a right slide-in over the list. */
  formStyle?: 'page' | 'drawer';
}

export interface DemoLineItem {
  id: string;
  description: string;
  sku?: string;
  listPrice?: number;
  quantity: number;
  unit: string;
  unitPrice: number;
  discount: number;
}
