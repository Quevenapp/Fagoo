import { lazy } from 'react';

// Stable component identities: loading a route never recreates its controller or editor.
export const Catalog = lazy(() => import('./RealCatalog'));
// Produtos (202610200119-120): categorias, grupos de produtos, tags e grupos de tags; exportação de produtos.
export const ProductTaxonomy = lazy(() => import('./ProductTaxonomy'));
export const ProductExport = lazy(() => import('./ProductExport'));
export const PriceLists = lazy(() => import('./PriceLists'));
// Campos customizados de produtos (202610200156).
export const CustomFields = lazy(() => import('./CustomFields'));
export const HistoryView = lazy(() => import('./HistoryView'));
export const RealDocuments = lazy(() => import('./RealDocuments'));
export const RealStock = lazy(() => import('./RealStock'));
export const RealFinance = lazy(() => import('./RealFinance'));
export const FinanceBorderos = lazy(() => import('./FinanceBorderos'));
export const FinanceScreens = lazy(() => import('./FinanceScreens'));
export const RealCnab = lazy(() => import('./RealCnab'));
export const CompanySettings = lazy(() => import('./CompanySettings'));
export const RealImportCatalog = lazy(() => import('./RealImportCatalog'));
export const RealHome = lazy(() => import('./RealHome'));
export const CutoverReadiness = lazy(() => import('./CutoverReadiness'));
export const RealFiscalDrafts = lazy(() => import('./RealFiscalDrafts'));
export const DueDateReport = lazy(() => import('./DueDateReport'));
export const SyncedXmlHistory = lazy(() => import('./SyncedXmlHistory'));
export const IntegrationProgress = lazy(() => import('./IntegrationProgress'));

export const RealCnabOperational = lazy(() => import('./RealCnabOperational'));
export const RealCnabOperationalReturns = lazy(() => import('./RealCnabOperationalReturns'));
export const CertificateA1 = lazy(() => import('./CertificateA1'));

export const RealReceivedDfe = lazy(() => import('./RealReceivedDfe'));
export const RealFiscalNumbering = lazy(() => import('./RealFiscalNumbering'));

export const SefazConnection = lazy(() => import('./SefazConnection'));

export const OriginPurchaseReadiness = lazy(() => import('./OriginPurchaseReadiness'));
export const OriginSalesReadiness = lazy(() => import('./OriginSalesReadiness'));
export const OriginSalesHistory = lazy(() => import('./OriginSalesHistory'));
export const ItauLegacyReadiness = lazy(() => import('./ItauLegacyReadiness'));
export const RealImportProposals = lazy(() => import('./RealImportProposals'));

export const OriginWarehouseImport = lazy(() => import('./OriginWarehouseImport'));

export const OriginStockObservations = lazy(() => import('./OriginStockObservations'));

export const RealStockOpening = lazy(() => import('./RealStockOpening'));

// Estoque lane (migrations 105-107).
export const StockWarehouses = lazy(() => import('./StockWarehouses'));
export const StockCount = lazy(() => import('./StockCount'));
export const StockDashboards = lazy(() => import('./StockDashboards'));
export const ReceiptCheckin = lazy(() => import('./ReceiptCheckin'));
export const StockReports = lazy(() => import('./StockReports'));

// Notas fiscais no padrão Origin (202610200111-114).
export const RealFiscalInvoices = lazy(() => import('./RealFiscalInvoices'));
export const RealOperationNatures = lazy(() => import('./RealOperationNatures'));
export const FiscalEventList = lazy(() => import('./FiscalEventList'));

// Vendas › Frente de caixa (202610200204-206), em tela cheia.
export const RealPdv = lazy(() => import('./RealPdv'));

export const CompanyPreferences = lazy(() => import('./CompanyPreferences'));
