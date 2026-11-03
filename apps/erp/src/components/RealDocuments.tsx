import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { TechnicianOptions } from './TechnicianOptions';
import DocumentMirrorView from './DocumentMirrorView';
import { DOCUMENT_MIRROR_READ_ONLY, isMirrorRecord, type DocumentReadRecord } from '../lib/document-mirror-model';
import {useLocation,useNavigate} from 'react-router-dom';
import { AccessError, decimalMoney, type AccessController } from '../lib/real-access';
import { useUnsavedChanges, useUnsavedChangesGuard } from '../hooks/useUnsavedChanges';
import type { CatalogAccess, CatalogEntity, CatalogPage, CatalogRecord } from '../lib/catalog-model';
import { STATES, TRANSITIONS, canEdit, checkTransition, calculateDocument, explicitDocumentInput, documentInput, documentValidation, freshDocument,conversionDocument,
  type DocumentAccess, type DocumentKind, type DocumentInput, type DocumentRecord, type DocumentEnvelope, type ConversionEnvelope, type ConversionKind, type DocumentItemInput } from '../lib/real-documents-model';
import './real-documents.css';
import DocumentAttachments from './DocumentAttachments';
import DocumentCommercialFields,{CommercialReferenceFields,emptyCommercial,emptyTransport} from './DocumentCommercialFields';
import {DocumentContactCheck,DocumentProposalNumber} from './DocumentEditorNotices';
import PdvOrderOrigin from './PdvOrderOrigin';
import type {PlatformPort} from '../lib/platform-model';
import DocumentDeliveryAddress from './DocumentDeliveryAddress';
import {BELOW_LIST_TITLE,belowListPrice,discountText,parseDiscountText,quantitySum,registeredAt} from '../lib/document-editor-totals';
import {CONDITION_HELP,PROPOSAL_CONDITION_HELP,conditionInstallments,daysFrom,dueFromDays} from '../lib/document-payment-condition';
import {missingRequired,requiredMessage} from '../lib/document-required';
import DocumentInstallmentPlanner from './DocumentInstallmentPlanner';
import {applyMonthlyDocumentPlan,type DocumentMonthlyPlan} from '../lib/document-installment-plan';
import DocumentPrintPreview from './DocumentPrintPreview';
import DocumentFinance from './DocumentFinance';
import FinanceContactOpenTitles from './FinanceContactOpenTitles';
import {documentFinanceTitlePath,financeLinkActor} from '../lib/document-finance-link';
import DocumentStock from './DocumentStock';
import PurchaseReceipts from './PurchaseReceipts';
import {purchaseReceiptsAllowed,type PurchaseReceiptsPage} from '../lib/purchase-receipts-model';
import SalesOrderReservations from './SalesOrderReservations';
import {reservationCanRead} from '../lib/stock-reservations-model';
import ServiceOrderJournal from './ServiceOrderJournal';
import ServiceOrderEvents from './ServiceOrderEvents';
import DocumentCopyNotice from './DocumentCopyNotice';
import {CatalogPicker} from './DocumentCatalogPicker';
import DocumentQuickContact,{type QuickContactState} from './DocumentQuickContact';
import DocumentProductStock from './DocumentProductStock';
import {incrementQuantity,quickContactAllowed,quickContactInitial,type QuickContactValues} from '../lib/document-editor-pickers';
import DocumentCopyOrigin from './DocumentCopyOrigin';
import {readCopyPreview,readCopyResult,CopyPreviewChanged,type DocumentCopyDraft,type DocumentCopyPreview} from '../lib/document-copy-model';
import {compactDocumentDecimal,documentDecimalDisplay,documentDecimalInput,documentFormValues,limitedDecimal,roundedDecimal} from '../lib/document-decimals';
import {documentEffectState,effectTransitionAllowed} from '../lib/document-effects-model';
import { IndicatorLetter } from './OriginList';
import { opensInNewTab } from '../lib/origin-list';
import DocumentStatusBadge from './DocumentStatusBadge';
import { Icon } from './Icon';
import DocumentList from './DocumentList';
import { usePurchasePrices } from './PurchasePrices';
import DocumentOccurrences from './DocumentOccurrences';
import {EMPTY_LIST_FILTERS,defaultListFilters,documentListQuery,pageCount,readDocumentListPage,reasonRequired,type DocumentListFilters,type DocumentListOrder,type DocumentListPage,type DocumentListRow} from '../lib/document-list-model';
import {LIST_VIEW_KINDS,readListView,type ListView} from '../lib/document-list-view-model';
import { normalizeUnitPrice, UNIT_PRICE_INPUT_LIMIT } from '../../../../packages/erp-domain/src/unit-price.mjs';
import { documentNumber } from '../../../../packages/erp-domain/src/index.mjs';
import {defaultDocumentPreferences,readDocumentPreferences,warrantyUntil,type DocumentPreferences} from '../lib/document-preferences';
import {grossWeightSum} from '../lib/document-weight';
import DocumentOptionalSection from './DocumentOptionalSection';
import DocumentNumbering from './DocumentNumbering';
import DocumentReports from './DocumentReports';
import DocumentPendencies from './DocumentPendencies';
import {isReportId,reportKind,type ReportId} from '../lib/document-reports-model';
import DocumentSellerPicker,{type SellerOption} from './DocumentSellerPicker';
import DocumentSalesToService from './DocumentSalesToService';
import DocumentCategoryPicker from './DocumentCategoryPicker';
import DocumentHistory from './DocumentHistory';
import DocumentItemStock from './DocumentItemStock';
import {SourceLotsPanel} from './StockMovementLots';
import DocumentKitComponents from './DocumentKitComponents';
import DocumentPriceList from './DocumentPriceList';
import DocumentContactSearch from './DocumentContactSearch';
import DocumentDiscountApproval from './DocumentDiscountApproval';
import { Modal } from './Modal';
import { ContactEditor } from './ContactEditor';
import { listPricesPath, readListPrices } from '../lib/document-price-list-model';
import type { HistoryRequest } from '../lib/document-history-model';
import type { ImportDraft } from '../lib/document-xml-import-model';
import {crossDockedDate,priceDecimalsProblem,quantityDecimalsProblem,quantityPlaces,sellerProblem} from '../lib/document-seller-rules';
import {stockLaunchDay} from '../lib/document-stock-model';
import {actionsAllowed,baseOf,managed,permittedTargets,readSituations,rowAt,rowKey,runnableTargets,situationName,situationPermissionNote,situationTargets,transitionActions,transitionNote,type RowSituation,type SituationModel} from '../lib/document-situations-model';
// Notas lane (202610200176): Total do IPI / Total do ICMS ST estimated by the note's tax engine.
import FiscalOrderTaxEstimate from './FiscalOrderTaxEstimate';
// 202610200196: Pagamento (Destino, Detalhes de pagamento, Forma e detalhes das parcelas) and the automatic lançamento de contas.
import {DocumentPaymentHeader,InstallmentDetailsDialog,InstallmentMethod,usePaymentOptions} from './DocumentPaymentDetails';
import type {PaymentOptions as DocumentPaymentOptions} from '../lib/document-payment-model';
import DocumentAutoFinance from './DocumentAutoFinance';
// 202610200199: Assinatura of the proposta (Saudação e Departamento of the user).
import DocumentSignature,{readSignature,SIGNATURE_PATH,type UserSignature} from './DocumentSignature';
// 202610200197: Sacola de vendas → new pedido de venda with its products.
import {SALES_BAG_PATH,readSalesBag,salesBagDraft} from '../lib/sales-bag-model';
import {methodCondition,withMethod} from '../lib/document-payment-model';
import {autoFinanceMessage,proposalDraft,supplierCodesPath,readSupplierCodes} from '../lib/document-pricing-model';
import {documentLabel} from '../lib/real-documents-model';
// 202610200268: Peças and Serviços executados of the OS.
import {ServiceOrderItems} from './ServiceOrderItems';
// 202610200270: texto rico (Outros itens ou serviços, Condições comerciais › Texto) and the Cabeçalho personalizado.
import {RichTextEditor} from './RichTextEditor';
import DocumentPrintHeader from './DocumentPrintHeader';
import {richTextEmpty,type RichText} from '../lib/rich-text-model';
import {groupTotals,itemGroup,serviceItemLabel,type ServiceItemGroup} from '../lib/service-order-items';
// Wave F: the Descrição of each free line searches the cadastro (Origin "Pesquise por código, descrição ou GTIN").
import {DocumentLineSuggestions,LINE_SEARCH_INFO,type LineKeyHandler} from './DocumentLineDescription';
import {PRODUCT_SEARCH_PLACEHOLDER} from '../lib/document-editor-pickers';
// Documentos lane, wave G (202610200287-291): Informar lotes, aba Comissões, Campos customizados da OS, Observações com efeitos
// ativos, casas decimais da quantidade, IPI % do pedido de compra and the Checkout de pedidos.
import DocumentItemLots,{useLotProducts} from './DocumentItemLots';
import DocumentItemCommissions from './DocumentItemCommissions';
import DocumentCustomFieldsSection,{useDocumentCustomFields} from './DocumentCustomFieldsSection';
import {CustomFieldsPrintQuestion,DocumentNotesNotice} from './DocumentWaveG';
import SalesCheckout from './SalesCheckout';
import {LOT_KINDS,lotsSummary} from '../lib/document-item-lots';
import {hasCustomValues} from '../lib/document-custom-fields';

const aborted=(error:unknown)=>error instanceof DOMException&&error.name==='AbortError';
const errorText=(error:unknown)=>error instanceof AccessError&&error.code==='MODULE_OWNED_BY_ORIGIN'?DOCUMENT_MIRROR_READ_ONLY:error instanceof AccessError&&error.code==='ERP_DOCUMENT_CREDIT_LIMIT'?'O valor total parcelado da proposta, somado às contas a receber em aberto do cliente, excede o limite de crédito do cliente (Preferências › Vendas › Propostas). Revise as parcelas ou o limite no cadastro do cliente.'
  // 202610200269: a proposta with a newer version is only consulted.
  // 016: the Origin already has contas or a nota for this document.
  :error instanceof AccessError&&error.code==='ERP_DOCUMENT_ORIGIN_EFFECTS'?'Este documento já tem contas lançadas ou nota fiscal gerada no Origin. Somente Observações e Observações internas podem ser alteradas.'
  :error instanceof AccessError&&error.code==='ERP_DOCUMENT_VERSION_LOCKED'?'Esta proposta tem uma versão mais nova e fica só para consulta. Abra a versão mais nova para alterá-la ou salvar outra versão.'
  :error instanceof AccessError ? error.status===409?'O documento mudou ou a ação não é permitida nesta situação. Suas alterações continuam no formulário; reabra o documento para conferir a versão atual.'
  // 202610200239: Sistema › Usuários › Permissões and the approval of the discount.
  :error.code==='ERP_DOCUMENT_PERMISSION_DENIED'?'Seu usuário não tem a permissão desta operação nas ordens de serviço (Sistema › Usuários › Permissões).'
  :error.code==='ERP_DOCUMENT_APPROVAL_REQUIRED'?'O pedido aguarda a aprovação do desconto: só quem pode desconsiderar o limite de desconto do vendedor muda a situação.'
  :error.code==='ERP_DOCUMENT_QUANTITY_DECIMALS'?'A quantidade tem mais casas decimais do que Preferências › Empresa › Geral permite.'
  :error.code==='ERP_DOCUMENT_LOT_UNAVAILABLE'?'Um lote informado não é do produto do item. Informe os lotes de novo.'
  :error.code==='ERP_DOCUMENT_CUSTOM_FIELD_REQUIRED'?'Preencha os campos customizados obrigatórios da ordem de serviço.'
  :error.code==='ERP_DOCUMENT_CUSTOM_FIELD_INACTIVE'?'Um campo customizado inativo não recebe valores novos.'
  :error.code==='ERP_DOCUMENT_CUSTOM_FIELD_INVALID'?'Confira os campos customizados da ordem de serviço.'
  :error.status===403?'Seu perfil não permite esta operação.':error.status===400?'Confira os campos, valores e referências selecionadas.':error.status===404?'Documento não encontrado. Atualize a listagem.':'Não foi possível concluir a operação. Tente novamente.':'Não foi possível concluir a operação. Tente novamente.';
const today=()=>{const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());return ['year','month','day'].map(type=>parts.find(part=>part.type===type)!.value).join('-');};
// Origin wording per kind (docs/references/origin-interface.md). The list screen itself is DocumentList.tsx.
const LIST_TITLES:Record<DocumentKind,string>={sales_proposals:'Propostas comerciais',sales_orders:'Pedidos de venda',purchase_orders:'Pedidos de compra',service_orders:'Ordem de serviço'};
const FORM_TITLES:Record<DocumentKind,string>={sales_proposals:'Proposta',sales_orders:'Pedido de venda',purchase_orders:'Pedido de compra',service_orders:'Ordem de serviço'};
const PRIMARY:Record<DocumentKind,{label:string;title:string}>={sales_proposals:{label:'Incluir proposta',title:'Incluir nova proposta'},sales_orders:{label:'Incluir pedido',title:'Incluir novo pedido'},purchase_orders:{label:'Incluir pedido',title:'Incluir novo pedido de compra'},service_orders:{label:'Incluir ordem',title:'Incluir uma nova ordem de serviço'}};
const DETAILS_TITLES:Record<DocumentKind,string>={sales_proposals:'Detalhes da proposta',sales_orders:'Detalhes da venda',purchase_orders:'Detalhes do pedido de compra',service_orders:'Detalhes da ordem de serviço'};
const TOTAL_LABELS:Record<DocumentKind,string>={sales_proposals:'Total da proposta',sales_orders:'Total da venda',purchase_orders:'Total do pedido',service_orders:'Total ordem de serviço'};
// Editar número: the number typed in the form travels with the body (never stored in it).
const requestedNumber=(body:Record<string,unknown>)=>{const data=body.data as {number?:unknown}|undefined;return typeof data?.number==='string'?data.number:null;};
const newItem=():DocumentItemInput=>({id:crypto.randomUUID(),product_id:null,description:'',code:null,unit:'UN',quantity:'1',unit_price:'0',discount_percent:'0',detailed_description:null});
// 202610200270 proposta: Outros itens with no text and no total are none (null); Condições comerciais Nenhum | Parcela | Texto.
const otherItemsValue=(content:RichText|null,total:string):DocumentInput['other_items']=>{const text=content&&!richTextEmpty(content)?content:null;return !text&&(!total||/^0*([.,]0*)?$/.test(total))?null:{content:text,total:total||'0'};};
const CONDITION_TABS=[['none','Nenhum'],['installments','Parcela'],['text','Texto']] as const;
// 202610200268: a free line of the Peças or of the Serviços executados of the OS.
const osLine=(group:ServiceItemGroup):DocumentItemInput=>({...newItem(),group,quote:false,done:false});

function Editor({controller,kind,record,writable,onClose,onSaved,onConverted,copyDraft=null,onCopyPrepared,onCopied,preferences,situations=null,access=null,importDraft=null}:{controller:AccessController;kind:DocumentKind;record:DocumentRecord|null;writable:boolean;onClose:()=>void;onSaved:(record:DocumentRecord,message?:string)=>void;onConverted:(result:ConversionEnvelope)=>void;copyDraft?:DocumentCopyDraft|null;onCopyPrepared?:(draft:DocumentCopyDraft)=>void;onCopied?:(record:DocumentRecord)=>void;preferences?:DocumentPreferences;situations?:SituationModel|null;access?:DocumentAccess|null;
  /** 202610200167 "Importar › Pedido XML": a new pedido prefilled from the XML (nothing saved yet). */
  importDraft?:ImportDraft|null}){
  const imported=!record&&!copyDraft&&importDraft?.kind===kind?importDraft:null;
  // 202610200164: company settings of the document screens and the vendedor linked to the user (absent before 164).
  const settings=access?.settings??null,mySeller=access?.seller??null,sellerKind=kind!=='purchase_orders';
  const defaultWarehouse=kind!=='sales_proposals'?settings?.default_warehouse??null:null;
  // 202610200163 Gerenciador de transições: situação keys, names and the actions of each transition (null keeps the situações padrão).
  const model=managed(situations,kind)?situations:null;const recordSituation=(record as (DocumentRecord&{situation?:RowSituation|null})|null)?.situation??null;
  const navigate=useNavigate();
  // Preferências of this kind (docs/integrations/documentos-origin-paridade.md); the server enforces the same rules.
  const fallbackPrefs=useMemo(()=>defaultDocumentPreferences(kind),[kind]);const prefs=preferences?.kind===kind?preferences:fallbackPrefs;
  const [userSignature,setUserSignature]=useState<UserSignature|null>(null),[signatureOpen,setSignatureOpen]=useState(false);
  const printOptions=useMemo(()=>({prefs:prefs.print,labels:prefs.labels,userSignature}),[prefs,userSignature]);
  // Origin "Observação padrão": only a new document (not a copy) starts with it.
  const freshNotes=record||copyDraft?'':prefs.observation;
  // A new document starts with the vendedor of the user (Origin) and the depósito padrão (Estoque › Depósitos).
  const initial=useMemo(()=>documentFormValues(explicitDocumentInput(copyDraft?structuredClone(copyDraft.preview.data):record?documentInput(record):imported?{...structuredClone(imported.data),...(sellerKind&&mySeller?{seller_id:mySeller.id}:{}),...(defaultWarehouse?{warehouse_id:defaultWarehouse.id}:{})}:{...freshDocument(kind,today(),freshNotes),...(sellerKind&&mySeller?{seller_id:mySeller.id}:{}),...(defaultWarehouse?{warehouse_id:defaultWarehouse.id}:{})})),[record,kind,copyDraft,imported,freshNotes,sellerKind,mySeller?.id,defaultWarehouse?.id]);
  const [values,setValues]=useState<DocumentInput>(initial);const [contact,setContact]=useState<{id:string;name:string}|null>(()=>copyDraft?copyDraft.contact:record?{id:record.contact_id,name:record.contact_snapshot.name}:imported?.contact??null);
  const [warehouse,setWarehouse]=useState<{id:string;name:string}|null>(()=>initial.warehouse_id?{id:initial.warehouse_id,name:!record&&!copyDraft&&defaultWarehouse?.id===initial.warehouse_id?defaultWarehouse.name:'Depósito do documento'}:null);
  const [seller,setSeller]=useState<SellerOption|null>(()=>initial.seller_id?{id:initial.seller_id,name:(record as (DocumentRecord&{seller_name?:string|null})|null)?.seller_name??(mySeller?.id===initial.seller_id?mySeller.name:'Vendedor do documento')}:null);
  // 202610200168: Categoria (pedidos de venda e de compra, OS) and Transportador of the cadastro (pedidos and propostas).
  const [category,setCategory]=useState<{id:string;name:string}|null>(()=>initial.category_id?{id:initial.category_id,name:record?.category_name??'Categoria do documento'}:null);
  const [carrier,setCarrier]=useState<{id:string;name:string}|null>(()=>initial.carrier_id?{id:initial.carrier_id,name:record?.carrier_name??'Transportador do documento'}:null);
  // 202610200169: históricos of the cliente, of the item for the cliente and of the purchases of the product (read-only).
  const [history,setHistory]=useState<HistoryRequest|null>(null);
  // Origin "Todos os depósitos" (cubos) of a line: balances per depósito and after the document (read-only).
  const [itemStock,setItemStock]=useState<{productId:string;description:string;code:string|null;quantity:string}|null>(null);
  // Estoque lane, onda F (278): "Informações de lote lançado" of an item whose stock the document posted.
  const [itemLots,setItemLots]=useState<{productId:string;description:string}|null>(null);
  // Estoque lane, onda F (280): "Componentes do item (kit)" of a saved composition item of a pedido de venda or OS.
  const [itemKit,setItemKit]=useState<string|null>(null);
  // 202610200287 Informar lotes (pedido de venda e peças da OS): the products with Controle de lote and the item being informed.
  // 202610200287/288: the reads of the onda G happen when they are used: the lots once the items are touched (or an item informs lots), the
  // campos customizados when their tab opens or an OS with values is printed, the commission rule when the Comissões grid shows.
  const [lotsWanted,setLotsWanted]=useState(false),[customOpen,setCustomOpen]=useState(false),[customWanted,setCustomWanted]=useState(false);
  const lotProducts=useLotProducts(controller,kind,LOT_KINDS.includes(kind)?values.items.map(item=>item.product_id).filter((id):id is string=>Boolean(id)):[],lotsWanted||values.items.some(item=>Boolean(item.lots?.length)));
  const [lotItem,setLotItem]=useState<number|null>(null);
  // 202610200288 aba Comissões (pedido de venda e OS), by the rule of the vendedor; Campos customizados of the OS.
  const [commissionsOpen,setCommissionsOpen]=useState(false);
  const customFields=useDocumentCustomFields(controller,kind==='service_orders'&&customWanted);
  const [printAsk,setPrintAsk]=useState<{include:boolean}|null>(null);
  const kitItem=(item:{id?:string|null;product_id?:string|null})=>(kind==='sales_orders'||kind==='service_orders')&&Boolean(record&&item.id&&item.product_id)
   &&record!.items.some(saved=>saved.id===item.id&&saved.product_id===item.product_id&&saved.product_snapshot?.format==='E');
  // Cadastros › Listas de preços in the pedido de venda and the proposta: the chosen list prices the products and, from 202610200196,
  // is saved with the document (price_list_id) with the Preço lista of each item.
  const [priceList,setPriceList]=useState<{id:string;name:string}|null>(()=>initial.price_list_id?{id:initial.price_list_id,name:record?.price_list_name??imported?.price_list_name??'Lista de preço do documento'}:null),[pricing,setPricing]=useState(''),[priceListNotice,setPriceListNotice]=useState('');
  // 202610200196: formas and contas of the Pagamento section, and the "Ver detalhes" of one parcela.
  const paymentSource=usePaymentOptions(controller,kind);
  // 202610200239: an OS without "Alterar forma de pagamento" (Sistema › Usuários) offers only the Formas it already has.
  const methodsLocked=kind==='service_orders'&&access?.permissions?.service_orders.payment_method===false;
  const savedMethods=new Set((record?.installments??[]).map(row=>row.payment_method_id).filter((id):id is string=>Boolean(id)));
  const restrictOptions=(options:DocumentPaymentOptions|null)=>options&&methodsLocked?{...options,methods:options.methods.filter(item=>savedMethods.has(item.id))}:options;
  const paymentOptions=restrictOptions(paymentSource.options);const [detailsIndex,setDetailsIndex]=useState<number|null>(null),[autoFinanceOpen,setAutoFinanceOpen]=useState(false);
  const [contactState,setContactState]=useState<string|null>(()=>typeof record?.contact_snapshot.state==='string'?record.contact_snapshot.state:null);
  const priceListRef=useRef(priceList);priceListRef.current=priceList;
  // Origin lupa "Pesquisar" of the Cliente/Fornecedor (busca avançada).
  const [contactSearch,setContactSearch]=useState(false);
  // Origin pedido de compra: the modal "Atenção" over the highlighted fields when required fields are missing.
  const [attention,setAttention]=useState('');
  // Origin lápis "Editar Contato": the contact form over the document; the next save takes the new data of the contact.
  const [contactEdit,setContactEdit]=useState(false),[refreshContact,setRefreshContact]=useState(false);
  const [catalogAccess,setCatalogAccess]=useState<CatalogAccess|null>(null);const [error,setError]=useState('');const [documentBusy,setBusy]=useState(false);const [uncertain,setUncertain]=useState(false);const [nextStatus,setNextStatus]=useState('');const [reason,setReason]=useState('');
  const [financeBusy,setFinanceBusy]=useState(false);const [financeDraft,setFinanceDraft]=useState(false);const [financeActive,setFinanceActive]=useState<boolean|null>(null);
  const [attachmentBusy,setAttachmentBusy]=useState(false);const [attachmentDraft,setAttachmentDraft]=useState(false);
  const [reservationBusy,setReservationBusy]=useState(false),[reservationDraft,setReservationDraft]=useState(false),[reservationActive,setReservationActive]=useState<boolean|null>(null);
  const reservationState=useRef<boolean|null>(null);
  const setReservationObserved=(active:boolean|null)=>{reservationState.current=active;setReservationActive(active);};
  const [stockBusy,setStockBusy]=useState(false);const [stockDraft,setStockDraft]=useState(false);const [stockActive,setStockActive]=useState<boolean|null>(null);
  const [receiptBusy,setReceiptBusy]=useState(false),[receiptDraft,setReceiptDraft]=useState(false),[receiptActive,setReceiptActive]=useState<boolean|null>(null),[receiptMode,setReceiptMode]=useState<PurchaseReceiptsPage['current']['document']['mode']|null>(null);
  const receiptState=useRef<{active:boolean|null;mode:typeof receiptMode}>({active:null,mode:null});
  const setReceiptObserved=(active:boolean|null)=>{receiptState.current.active=active;setReceiptActive(active);};
  const setReceiptModeObserved=(mode:NonNullable<typeof receiptMode>)=>{receiptState.current.mode=mode;setReceiptMode(mode);};
  const [journalBusy,setJournalBusy]=useState(false);const [journalDraft,setJournalDraft]=useState(false);
  const [eventBusy,setEventBusy]=useState(false);const [eventDraft,setEventDraft]=useState(false);
  const [installmentDraft,setInstallmentDraft]=useState(false);
  const plannerActor=useRef(controller.getSnapshot().membership?.user_id);
  const plannerMounted=useRef(true);
  const navigationController=useRef(controller);navigationController.current=controller;
  // Child callbacks update refs before scheduling a render, so retained parent
  // handlers cannot edit or remount this document while a child owns an attempt.
  const children=useRef({receipt:{busy:false,draft:false},reservation:{busy:false,draft:false},finance:{busy:false,draft:false},stock:{busy:false,draft:false},attachment:{busy:false,draft:false},journal:{busy:false,draft:false},event:{busy:false,draft:false},installment:{busy:false,draft:false}});
  const childCallbacks=useMemo(()=>{
    const setters={receipt:[setReceiptBusy,setReceiptDraft],reservation:[setReservationBusy,setReservationDraft],finance:[setFinanceBusy,setFinanceDraft],stock:[setStockBusy,setStockDraft],attachment:[setAttachmentBusy,setAttachmentDraft],journal:[setJournalBusy,setJournalDraft],event:[setEventBusy,setEventDraft]} as const;
    return Object.fromEntries(Object.entries(setters).map(([name,setters])=>[name,{
      onBusy:(value:boolean)=>{children.current[name as keyof typeof children.current].busy=value;setters[0](value);},
      onDraft:(value:boolean)=>{children.current[name as keyof typeof children.current].draft=value;setters[1](value);},
    }])) as Record<Exclude<keyof typeof children.current,'installment'>,{onBusy:(value:boolean)=>void;onDraft:(value:boolean)=>void}>;
  },[]);
  const [conversionReview,setConversionReview]=useState<ConversionKind|null>(null);const conversionHeading=useRef<HTMLHeadingElement>(null);
  const busy=receiptBusy||reservationBusy||documentBusy||financeBusy||attachmentBusy||stockBusy||journalBusy||eventBusy;const childDraft=receiptDraft||reservationDraft||financeDraft||attachmentDraft||stockDraft||journalDraft||eventDraft||installmentDraft;
  const financeRole=controller.getSnapshot().membership?.role;const financeEnabled=Boolean(record&&kind!=='sales_proposals'&&financeRole&&['admin','financeiro','consulta'].includes(financeRole));
  const receiptEnabled=Boolean(record&&kind==='purchase_orders');
  // 202610200239: Sistema › Usuários › Serviços › Ordem de Serviço "Lançar estoque" / "Lançar contas".
  const osStockDenied=kind==='service_orders'&&access?.permissions?.service_orders.stock===false,osFinanceDenied=kind==='service_orders'&&access?.permissions?.service_orders.finance===false;
  const stockEnabled=Boolean(record&&kind!=='sales_proposals'&&(!receiptEnabled||receiptMode==='legacy_full')&&financeRole&&['admin','estoque'].includes(financeRole))&&!osStockDenied;
  const eventsEnabled=Boolean(record&&kind==='service_orders'&&financeRole&&['admin','vendas','financeiro','consulta'].includes(financeRole));
  const [attachmentsOpen,setAttachmentsOpen]=useState(false);
  const [printOpen,setPrintOpen]=useState(false),[printTechnician,setPrintTechnician]=useState(false);
  useEffect(()=>{if(printOpen&&kind==='service_orders'&&record&&hasCustomValues(record.custom_fields))setCustomWanted(true);},[printOpen]);
  // 202610200199: the print of the proposta ends with the signature of the user who prints (read when the print opens).
  useEffect(()=>{if(!printOpen||kind!=='sales_proposals'||userSignature)return;const request=new AbortController(),actor=controller.getSnapshot().membership?.user_id;
    void Promise.resolve().then(()=>controller.documents(SIGNATURE_PATH,{signal:request.signal})).then(value=>{if(!request.signal.aborted&&controller.getSnapshot().membership?.user_id===actor)setUserSignature(readSignature(value));}).catch(()=>{/* Printed without the signature. */});
    return()=>request.abort();},[printOpen,kind,controller]);
  // Origin-style filling helpers: “Contato rápido”, code/GTIN entry and stock while choosing a product.
  const [quickContact,setQuickContact]=useState<QuickContactValues|null>(null),[quickState,setQuickState]=useState<QuickContactState>({busy:false,dirty:false,uncertain:false}),[contactStatus,setContactStatus]=useState('');
  const quickOpen=useRef(false);const [stockProduct,setStockProduct]=useState<{id:string;name:string;seq:number}|null>(null);
  // Origin form helpers: highlighted required fields, the "Descrição detalhada" toggle and the catalog price of each line.
  const [invalid,setInvalid]=useState<string[]>([]);const [detailOpen,setDetailOpen]=useState<Set<string>>(()=>new Set());const [itemNotice,setItemNotice]=useState('');
  // Wave F: the free line whose Descrição is focused, and whether the user typed there (only then its search opens).
  const [lineSearch,setLineSearch]=useState<{index:number;typed:boolean}|null>(null);const lineKeys=useRef<LineKeyHandler|null>(null),lineBlur=useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(()=>()=>{if(lineBlur.current)clearTimeout(lineBlur.current);},[]);
  const listPrices=useRef(new Map<string,unknown>((record?.items??[]).filter(item=>item.id&&item.product_id).map(item=>[item.id!,item.product_snapshot?.price])));
  const [condition,setCondition]=useState('');const [occurrencesOpen,setOccurrencesOpen]=useState(false);
  // Origin title "Pedido de venda - <próximo número>" for a new document; the number is only confirmed when saving.
  const [nextNumber,setNextNumber]=useState<string|null>(null);
  useEffect(()=>{if(record||copyDraft||!writable)return;const request=new AbortController(),actor=controller.getSnapshot().membership?.user_id;
    void Promise.resolve().then(()=>controller.documents(`/v1/documentos/${kind}/proximo-numero`,{signal:request.signal})).then(value=>{const result=value as {kind?:unknown;next_number?:unknown}|null;
      if(request.signal.aborted||controller.getSnapshot().membership?.user_id!==actor||!result||result.kind!==kind||typeof result.next_number!=='string'||!/^[1-9]\d{0,9}$/.test(result.next_number))return;setNextNumber(result.next_number);}).catch(()=>{/* The title keeps the plain name. */});
    return()=>request.abort();},[controller,kind,record,copyDraft,writable]);const [discountDraft,setDiscountDraft]=useState(()=>discountText(initial));
  // Cadastros › Vendedores "Permite visualizar informações de estoque nos pedidos de venda e ordens de serviço": a vendedor
  // without it does not see the balances in the sales documents (the pedido de compra is not a sales document).
  const contactCreatable=quickContactAllowed(catalogAccess,financeRole),stockReadable=Boolean(financeRole&&reservationCanRead(financeRole))&&!(sellerKind&&mySeller&&!mySeller.view_stock);
  const autoProducts=Boolean(settings&&(kind==='purchase_orders'?settings.auto_products.purchases:kind==='service_orders'?settings.auto_products.services:settings.auto_products.sales)&&financeRole&&['admin','estoque'].includes(financeRole));
  const pending=useRef<AbortController|null>(null);const command=useRef<{id:string;path:string;method:'POST'|'PATCH';body:Record<string,unknown>;conversion:ConversionKind|null;copy:DocumentCopyPreview|null;saved:DocumentEnvelope|ConversionEnvelope|null;uncertain:boolean;bagCleared?:boolean}|null>(null);const heading=useRef<HTMLHeadingElement>(null);
  const effects=documentEffectState(record?.effect_flags,financeActive,stockActive===true||receiptActive===true?true:stockActive);const effectsUnknown=Boolean(record&&!effects.known);
  const reservationEnabled=Boolean(record&&kind==='sales_orders');
  // 202610200269: a proposta with a newer version is only consulted (the server refuses its save).
  const superseded=kind==='sales_proposals'&&Boolean(record?.proposal_version?.superseded);const [saveMenu,setSaveMenu]=useState(false);
  // Estoque lane, onda F (279): a pedido de compra with posted stock (recebimentos or the whole pedido) and no contas keeps the header
  // editable, as in Origin; the items, the fornecedor and the depósito stay read-only (the stock guards allow only that).
  const stockEditable=kind==='purchase_orders'&&Boolean(record)&&writable&&!effectsUnknown&&effects.stock&&!effects.finance&&(!financeEnabled||financeActive===false)
   &&(!receiptEnabled||receiptActive!==null)&&(!stockEnabled||stockActive!==null)&&(!record||canEdit(kind,record.status));
  const bodyEditable=!superseded&&writable&&(!receiptEnabled||receiptActive===false)&&(!reservationEnabled||reservationActive===false)&&(!record||canEdit(kind,record.status))&&!effectsUnknown&&!effects.active&&!effects.origin&&(!financeEnabled||financeActive===false)&&(!stockEnabled||stockActive===false)||stockEditable;const editable=bodyEditable&&!childDraft;const dirty=JSON.stringify(documentFormValues(values))!==JSON.stringify(initial);
  // 202610200290 Origin: with stock, contas, reservas or recebimentos active the form is read-only except Observações and Observações
  // internas, saved by their own command (erp_document_notes_save).
  const notesOnly=Boolean(record)&&writable&&!editable&&!superseded&&kind!=='sales_proposals'&&!effectsUnknown&&!childDraft&&(effects.active||effects.origin||reservationActive===true||receiptActive===true);
  const notesLive=useRef(notesOnly);notesLive.current=notesOnly;
  const situationRow=record?{status:record.status,situation:recordSituation,template:Boolean(record.template),finance_active:effects.finance,stock_active:effects.stock,receipt_active:receiptActive===true,reservation_active:reservationActive===true}:null;
  const currentKey=record?rowKey({status:record.status,situation:recordSituation}):'';
  // 202610200239: Sistema › Usuários (Gerenciar situações da OS) and the approval of the discount narrow the targets.
  const transitions=permittedTargets(kind,currentKey,record&&situationRow&&effects.known&&(!receiptEnabled||receiptActive!==null)&&(!reservationEnabled||reservationActive!==null)?(model?situationTargets(model,kind,situationRow):(TRANSITIONS[kind][record.status]||[]).filter(status=>!effects.active&&!reservationActive||effectTransitionAllowed(kind,record.status,status,effects.finance))):[],access?.permissions);
  const situationNote=record?situationPermissionNote(kind,currentKey,access?.permissions):null;
  const nextActions=model&&nextStatus?transitionActions(model,kind,currentKey,nextStatus):[];const nextBlocked=!actionsAllowed(nextActions,financeRole??'');
  const guard=useUnsavedChanges(dirty||childDraft||Boolean(copyDraft||imported||nextStatus||reason||conversionReview||refreshContact)||quickState.dirty||quickState.uncertain,busy||uncertain||quickState.busy);
  const planSource=`${kind}:${record?.id||copyDraft?.preview.source.id||'new'}:${record?.version||copyDraft?.preview.source.version||0}:${copyDraft?'copy':'document'}`;
  const live=useRef({editable,bodyEditable,stockEditable,dirty,documentBusy,uncertain,nextStatus,reason,conversionReview,values,planSource});live.current={editable,bodyEditable,stockEditable,dirty,documentBusy,uncertain,nextStatus,reason,conversionReview,values,planSource};
  // The Preferências page may arrive after a new document opened: its default observation replaces the empty one only
  // while the user has not typed anything, so no typed value is ever overwritten.
  const baseline=useRef(initial);
  useEffect(()=>{const previous=baseline.current;baseline.current=initial;if(previous===initial||record||copyDraft||isLocked())return;
    if(JSON.stringify(documentFormValues(live.current.values))!==JSON.stringify(previous))return;live.current.values=initial;live.current.dirty=false;setValues(initial);setDiscountDraft(discountText(initial));},[initial]);
  // Gross weight of the linked products: catalog rows chosen here, or the snapshot saved with each line.
  const weights=useRef(new Map<string,unknown>((record?.items??[]).filter(item=>item.id&&item.product_id).map(item=>[item.id!,item.product_snapshot?.gross_weight])));
  // 202610200199 "Número de casas decimais no peso do produto": the sum is shown and saved with those casas (half up), so the
  // print shows the same weight as the form.
  const summedWeight=prefs.sumGrossWeight&&kind!=='service_orders'?grossWeightSum(values.items,item=>item.id?weights.current.get(item.id):undefined):undefined;
  const computedWeight=summedWeight&&typeof settings?.weight_decimals==='number'?roundedDecimal(summedWeight,settings.weight_decimals):summedWeight;
  const contactLabel=kind==='purchase_orders'?'Fornecedor':prefs.labels.cliente??'Cliente';
  const nextContactRequired=prefs.nextContactRequired&&kind==='sales_proposals'&&!values.template;
  const BASE_LABELS={date:kind==='sales_orders'?'Data da venda':'Data',ship_date:kind==='service_orders'?'Data de Saída':'Data saída',expected_date:'Data prevista'} as const;
  const installmentBase=prefs.installmentBase==='ship_date'&&kind!=='sales_orders'&&kind!=='service_orders'?'date':prefs.installmentBase;
  const baseDate=(installmentBase==='date'?values.date:values[installmentBase])||'';
  const dayBase=baseDate||values.date;
  // Preferências › OS "Inserção de dados da OS por partes": a saved OS shows the reception as a summary until "Editar dados do recebimento".
  const [receptionOpen,setReceptionOpen]=useState(false);
  const receptionSummary=kind==='service_orders'&&prefs.receptionInParts&&Boolean(record)&&!receptionOpen;
  // Preferências › OS "Exibir desconto e preço de lista dos itens" (an OS already carrying a discount keeps the column).
  // Origin pedido de venda and proposta: "Preço lista" (somente leitura) is always a column of the items.
  const listPriceColumn=kind==='sales_orders'||kind==='sales_proposals'||(kind==='service_orders'&&prefs.showListDiscount);
  // Preferências › Serviços "Data base da garantia": the end of the garantia of the OS (none with "Não utilizar garantia").
  const warrantyEnd=kind==='service_orders'?warrantyUntil(values,prefs.print.warrantyBase):null;
  const listPriceOfLine=(item:DocumentItemInput)=>item.list_price??(typeof listPrices.current.get(item.id??'')==='string'?String(listPrices.current.get(item.id??'')):null);
  // Origin pedido de compra: no line discount and no Outras despesas, unless an older pedido already carries them.
  const lineDiscount=(kind!=='purchase_orders'&&(kind!=='service_orders'||prefs.showListDiscount))||values.items.some(item=>compactDocumentDecimal(item.discount_percent??'0')!=='0');
  // Origin Alt+Z "Adicionar outro item" (free line, when the Preferências allow it).
  const addLineShortcut=(event:{altKey:boolean;key:string;preventDefault:()=>void})=>{if(!event.altKey||event.key.toLowerCase()!=='z')return;event.preventDefault();if(!mayEditBody()||!prefs.freeItems||live.current.values.items.length>=250)return;patch('items',[...live.current.values.items,kind==='service_orders'?osLine('part'):newItem()]);};
  const childHasDraft=()=>Object.values(children.current).some(value=>value.draft);
  const isLocked=()=>Boolean(pending.current||command.current||live.current.documentBusy||live.current.uncertain||Object.values(children.current).some(value=>value.busy));
  const openFinanceTitle=(titleId:string)=>{
    if(!record)return;const source=live.current.planSource,actor=plannerActor.current;
    const available=()=>plannerMounted.current&&navigationController.current===controller&&Boolean(actor&&financeLinkActor(controller.getSnapshot())===actor)&&source===live.current.planSource&&!isLocked();
    if(!available())return;const path=documentFinanceTitlePath(record.kind,titleId);
    guard.confirmLeave(()=>{if(available())navigate(path);});
  };
  const mayEditBody=()=>live.current.editable&&(!receiptEnabled||receiptState.current.active===false||live.current.stockEditable)&&(!reservationEnabled||reservationState.current===false)&&!isLocked()&&!childHasDraft();
  const mayAct=(clean=false)=>!isLocked()&&!childHasDraft()&&(!clean||!live.current.dirty&&!live.current.nextStatus&&!live.current.reason&&!live.current.conversionReview);
  const childConflict=(owner:keyof typeof children.current)=>live.current.dirty||live.current.uncertain||Boolean(command.current||live.current.nextStatus||live.current.reason||live.current.conversionReview)||Object.entries(children.current).some(([name,value])=>name!==owner&&(value.busy||value.draft));
  const totals=useMemo(()=>{try{return calculateDocument(values);}catch{return null;}},[values]);
  useEffect(()=>{if(invalid.length){const still=new Set(missingRequired(kind,values).map(field=>field.id));setInvalid(previous=>previous.filter(id=>still.has(id)));}},[values]);
  const invalidProps=(id:string)=>invalid.includes(id)?{'aria-invalid':true as const}:{};
  const sumOfQuantities=quantitySum(values.items);
  const osSums=kind==='service_orders'?groupTotals(values.items,totals):null;
  // 202610200270: Condições comerciais of the proposta (an older proposta without the field is Parcela); Nenhum and Texto have no parcelas.
  const conditionsMode=kind==='sales_proposals'?values.commercial_conditions?.mode??'installments':'installments',conditionsInstallments=conditionsMode==='installments';
  const setConditionsMode=(mode:'none'|'installments'|'text')=>{if(!mayEditBody()||mode===conditionsMode)return;patch('commercial_conditions',{mode,text:live.current.values.commercial_conditions?.text??null});if(mode!=='installments'&&live.current.values.installments?.length)patch('installments',[]);};
  const mayPlan=()=>{
    const snapshot=controller.getSnapshot(),member=snapshot.membership;
    return plannerMounted.current&&snapshot.phase==='ready'&&Boolean(plannerActor.current&&member?.user_id===plannerActor.current&&['admin',kind==='purchase_orders'?'estoque':'vendas'].includes(member.role))&&live.current.bodyEditable&&(!receiptEnabled||receiptState.current.active===false)&&(!reservationEnabled||reservationState.current===false)&&!isLocked()&&!live.current.nextStatus&&!live.current.reason&&!live.current.conversionReview&&!Object.entries(children.current).some(([name,value])=>name!=='installment'&&(value.busy||value.draft));
  };
  const planDraft=(value:boolean)=>{children.current.installment.draft=value;setInstallmentDraft(value);};
  const applyPlan=(reviewed:DocumentMonthlyPlan)=>{
    if(!mayPlan()||!children.current.installment.draft)return false;
    try{const installments=applyMonthlyDocumentPlan(live.current.planSource,live.current.values,reviewed);const next={...live.current.values,installments};live.current.values=next;live.current.dirty=true;setValues(next);setError('');return true;}
    catch(failure){setError(failure instanceof Error?failure.message:'Confira novamente as parcelas.');return false;}
  };
  useEffect(()=>{plannerMounted.current=true;return()=>{plannerMounted.current=false;};},[]);
  useEffect(()=>{heading.current?.focus();const request=new AbortController();void controller.catalog('/v1/cadastros',{signal:request.signal}).then(value=>{if(!request.signal.aborted)setCatalogAccess(value as CatalogAccess);}).catch(()=>{/* Read permissions are separately enforced. */});return()=>{request.abort();pending.current?.abort();};},[controller]);
  useEffect(()=>{if(conversionReview)conversionHeading.current?.focus();},[conversionReview]);
  const patch=<K extends keyof DocumentInput>(key:K,value:DocumentInput[K])=>{if(!mayEditBody()||live.current.stockEditable&&['items','contact_id','warehouse_id'].includes(key))return;const next={...live.current.values,[key]:value};live.current.values=next;live.current.dirty=JSON.stringify(documentFormValues(next))!==JSON.stringify(initial);setValues(next);};
  const changeItem=(index:number,change:Partial<DocumentItemInput>)=>{if(mayEditBody())patch('items',live.current.values.items.map((item,i)=>i===index?{...item,...change}:item));};
  const patchNotes=(key:'notes'|'internal_notes',value:string)=>{if(live.current.editable){patch(key,value);return;}if(!notesLive.current||isLocked()||childHasDraft())return;
    const next={...live.current.values,[key]:value};live.current.values=next;live.current.dirty=JSON.stringify(documentFormValues(next))!==JSON.stringify(initial);setValues(next);};
  const lotLink=(item:DocumentItemInput,index:number)=>LOT_KINDS.includes(kind)&&item.product_id&&lotProducts.has(item.product_id)&&itemGroup(item)!=='service'
    ?<a href="#" role="button" className="text-button document-item-lots-inform" aria-label={`Informar lotes do item ${index+1}`} title="Informar lotes" onClick={event=>{event.preventDefault();setLotItem(index);}}>{item.lots?.length?lotsSummary(item.lots):'Informar lotes'}</a>:null;
  const execute=async()=>{
    const operation=command.current;if(!operation||pending.current||Object.values(children.current).some(value=>value.busy||value.draft))return;
    const request=new AbortController();pending.current=request;setBusy(true);setError('');
    try{
      if(!operation.saved){
        const result=await (operation.copy?controller.documentCopy:controller.documents)(operation.path,{method:operation.method,body:{...operation.body,command_id:operation.id},signal:request.signal}) as DocumentEnvelope|ConversionEnvelope;
        if(request.signal.aborted)return;
        if(operation.copy){try{readCopyResult(result,operation.copy);}catch{throw new AccessError(502);}}
        else if(operation.conversion){const converted=result as ConversionEnvelope,target=conversionDocument(converted);if(target.kind!==operation.conversion||target.version!==1||!(target.status==='open'||(operation.conversion==='sales_orders'&&target.status==='draft'))||converted.proposal.id!==record?.id||converted.proposal.version!==Number(operation.body.expected_version)+1)throw new AccessError(502);}
        else if(!(result as DocumentEnvelope).document?.id||(result as DocumentEnvelope).document.kind!==kind)throw new AccessError(502);
        operation.saved=result;
      }
      // Replays acknowledge the original command; only a fresh read is current state.
      if(operation.conversion){
        const saved=operation.saved as ConversionEnvelope,target=conversionDocument(saved);
        const latest=await controller.documents(`/v1/documentos/${target.kind}/${target.id}`,{signal:request.signal}) as DocumentEnvelope;
        if(request.signal.aborted)return;
        if(latest.document.id!==target.id||latest.document.kind!==target.kind||latest.document.source_proposal_id!==saved.proposal.id||!Number.isInteger(latest.document.version)||latest.document.version<target.version)throw new AccessError(502);
        guard.store.runConfirmed(()=>onConverted(operation.conversion==='service_orders'?{proposal:saved.proposal,service_order:latest.document,replayed:saved.replayed,data_mode:'erp_native',operational_effects:false}:{proposal:saved.proposal,sale:latest.document,replayed:saved.replayed,data_mode:'erp_native',operational_effects:false}));
      }else{
        const saved=operation.saved as DocumentEnvelope;
        const latest=await controller.documents(`/v1/documentos/${kind}/${saved.document.id}`,{signal:request.signal}) as DocumentEnvelope;
        if(request.signal.aborted)return;
        if(latest.document.id!==saved.document.id||latest.document.kind!==kind||(operation.copy&&(!Number.isInteger(latest.document.version)||latest.document.version<saved.document.version||latest.document.source_proposal_id!==null)))throw new AccessError(502);
        const numberMessage=(!record&&(requestedNumber(operation.body)??nextNumber)&&latest.document.number!==(requestedNumber(operation.body)??nextNumber))||(record&&requestedNumber(operation.body)&&latest.document.number!==requestedNumber(operation.body))?`O número do seu ${kind==='sales_orders'?'pedido':'documento'} foi modificado para: ${latest.document.number}`:undefined;
        const source=(saved as DocumentEnvelope&{source_proposal?:{number:string}}).source_proposal;
        // 202610200197: the pedido made from the Sacola de vendas empties the bag once it is saved; the message says what happened
        // (a failure keeps the bag, which can be emptied in the drawer).
        let bagMessage:string|undefined;
        if(!record&&imported?.sales_bag&&!operation.copy&&!operation.bagCleared){operation.bagCleared=true;
          bagMessage=await Promise.resolve().then(()=>controller.documents(SALES_BAG_PATH,{method:'POST',body:{command_id:crypto.randomUUID(),action:'clear'}}))
            .then(()=>'Sacola de vendas esvaziada.',()=>'Não foi possível esvaziar a sacola de vendas; use Limpar sacola na listagem de produtos.');
          if(request.signal.aborted)return;}
        // 202610200239: above the discount limit of the seller the pedido went to the approval situação (Origin wording).
        const approvalSituation=(saved as DocumentEnvelope&{discount_approval?:{situation?:{name?:string}}}).discount_approval?.situation?.name;
        const versionLabel=(saved as DocumentEnvelope&{proposal_version?:{label?:string}}).proposal_version?.label;
        const messages=[numberMessage,source?`Proposta ${source.number} concluída.`:undefined,bagMessage,autoFinanceMessage((saved as DocumentEnvelope&{auto_finance?:unknown}).auto_finance,kind==='purchase_orders'?'purchase_orders':'sales_orders'),
          approvalSituation?`Venda enviada para aprovação do desconto (situação ${approvalSituation}).`:undefined,versionLabel?`Nova versão ${versionLabel} da proposta salva.`:undefined].filter(Boolean);
        if(operation.copy)guard.store.runConfirmed(()=>(onCopied||onSaved)(latest.document));else onSaved(latest.document,messages.length?messages.join(' '):undefined);
      }
    }catch(failure){if(!request.signal.aborted&&!aborted(failure)){
      const known=!operation.saved&&!operation.uncertain&&failure instanceof AccessError&&[400,403,404,409].includes(failure.status);
      if(known)command.current=null;else operation.uncertain=true;setUncertain(!known);
      const typed=requestedNumber(operation.body);
      setError(known?typed&&failure instanceof AccessError&&failure.status===409?`O número ${typed} pode já estar em uso, ou o documento mudou. Informe outro número (ou apague o campo para usar a numeração automática) e confira a versão atual.`:errorText(failure):operation.saved?'O documento foi registrado, mas a versão atual não pôde ser consultada. Use “Conferir resultado” antes de editar novamente.':'Não foi possível confirmar o resultado. Use “Conferir resultado” para repetir a mesma operação sem criar outro documento.');
    }}finally{if(pending.current===request)pending.current=null;if(!request.signal.aborted)setBusy(false);}
  };
  const run=(path:string,method:'POST'|'PATCH',input:Record<string,unknown>,conversion:ConversionKind|null=null,copy:DocumentCopyPreview|null=null)=>{
    if(!mayAct())return;
    command.current={id:crypto.randomUUID(),path,method,body:structuredClone(input),conversion,copy:copy?structuredClone(copy):null,saved:null,uncertain:false};void execute();
  };
  const submit=(event:FormEvent,asVersion=false)=>{event.preventDefault();
    if(notesLive.current&&record&&!asVersion){if(!isLocked()&&!childHasDraft())run(`/v1/documentos/${kind}/${record.id}/observacoes`,'POST',{expected_version:record.version,notes:live.current.values.notes||null,internal_notes:live.current.values.internal_notes||null});return;}
    if(!mayEditBody())return;const missing=missingRequired(kind,values,{nextContact:nextContactRequired,contactLabel});setInvalid(missing.map(field=>field.id));if(missing.length){const text=`${missing.map(requiredMessage).join('. ')}.`;setError(text);if(kind==='purchase_orders')setAttention(text);return;}
    // Preferências rules, with the Origin wording; the server refuses the same bodies.
    if(values.number!==undefined&&!documentNumber(values.number)){setInvalid(['doc-number']);setError('Informe um número de 1 a 9999999999, sem zeros à esquerda.');return;}
    if(!prefs.freeItems){const free=values.items.flatMap((item,index)=>item.product_id?[]:[`doc-item-description-${index}`]);if(free.length){setInvalid(free);setError('Não é permitido vender produtos não cadastrados.');return;}}
    // 202610200164: vendedor obrigatório, the vendedor of the user and the casas decimais (the server checks the same).
    if(sellerKind&&prefs.sellerRequired&&!values.seller_id&&!(kind==='sales_proposals'&&values.template)){setInvalid(['doc-seller']);setError('O campo Vendedor é obrigatório.');return;}
    for(const problem of [priceDecimalsProblem(kind,values,settings),quantityDecimalsProblem(values,settings),sellerProblem(kind,values,totals,mySeller)])if(problem){setInvalid(problem.invalid);setError(problem.message);return;}
    if(kind==='service_orders'&&Array.isArray(customFields)){const required=customFields.find(field=>field.active&&field.required&&!values.custom_fields?.[field.id]);if(required){setInvalid([`doc-custom-${required.id}`]);setError(`O campo ${required.name} é obrigatório (Campos Customizados).`);return;}}
    if(!prefs.repeatedItems){const seen=new Set<string>();const repeated=values.items.findIndex(item=>{if(!item.product_id)return false;if(seen.has(item.product_id))return true;seen.add(item.product_id);return false;});if(repeated>=0){setInvalid([`doc-item-description-${repeated}`]);setError('Item repetido: as Preferências das ordens de serviço não permitem o mesmo produto em mais de uma linha.');return;}}
    // "Somar peso bruto dos produtos": the saved gross weight is the computed sum (empty when no product has one).
    // 202610200196: every line and parcela carries the new keys (null when unused), so the server never sees them dropped.
    let data=explicitDocumentInput(values,kind);
    if(computedWeight!==undefined){const commercial=values.commercial??emptyCommercial(),transport=commercial.transport??emptyTransport();if((transport.gross_weight??null)!==computedWeight)data={...data,commercial:{...commercial,transport:{...transport,gross_weight:computedWeight}}};}
    const message=documentValidation(kind,data);if(message){setError(message);return;}
    // 202610200269 "Salvar nova versão": the form becomes a new version of the proposta (automatic number, never a requested one).
    if(asVersion){if(!record||kind!=='sales_proposals'||record.template)return;const {number:_requested,...versionData}=data;run(`/v1/documentos/sales_proposals/${record.id}/nova-versao`,'POST',{data:versionData,expected_version:record.version});return;}
    if(copyDraft){run(`/v1/duplicacao-documentos/${kind}/${copyDraft.preview.source.id}`,'POST',{data,expected_source_version:copyDraft.preview.source.version},null,copyDraft.preview);return;}run(`/v1/documentos/${kind}${record?`/${record.id}`:''}`,record?'PATCH':'POST',{data:record&&refreshContact&&data.contact_id===record.contact_id?{...data,refresh_contact:true}:data,...(record?{expected_version:record.version}:{}),...(!record&&imported?.source_proposal?{source_proposal:imported.source_proposal}:{})});};
  // `asModel`: Origin "Usar este como modelo" of the proposta (the reviewed copy is a modelo without a name yet).
  const prepareCopy=async(asModel=false)=>{
    if(!record||!writable||!onCopyPrepared||!mayAct(true))return;
    const request=new AbortController();pending.current=request;setBusy(true);setError('');
    try{const result=await controller.documentCopy(`/v1/duplicacao-documentos/${kind}/${record.id}/preview`,{signal:request.signal});if(request.signal.aborted)return;const read=readCopyPreview(result,record),preview=asModel&&kind==='sales_proposals'?{...read,data:{...read.data,template:true,template_name:null}}:read;onCopyPrepared({preview,contact:{id:record.contact_id,name:record.contact_snapshot.name}});}
    catch(failure){if(!request.signal.aborted)setError(failure instanceof CopyPreviewChanged?failure.message:errorText(failure));}
    finally{if(pending.current===request)pending.current=null;if(!request.signal.aborted)setBusy(false);}
  };
  const changeStatus=()=>{if(!record||!nextStatus)return;const nextBase=baseOf(model,kind,nextStatus);if(receiptEnabled&&(receiptState.current.active===null||receiptState.current.active===true&&!effectTransitionAllowed(kind,record.status,nextBase,effects.finance))||reservationEnabled&&(reservationState.current===null||reservationState.current===true&&!effectTransitionAllowed(kind,record.status,nextBase,effects.finance))||!mayAct()||live.current.dirty||live.current.conversionReview||nextStatus!==live.current.nextStatus||reason!==live.current.reason||!transitions.includes(nextStatus)||nextBlocked)return;
    if(model){if(reasonRequired(kind,currentKey,nextStatus,model)&&(reason.trim().length<3||/[\x00-\x1f\x7f]/.test(reason))){setError('Informe um motivo com pelo menos três caracteres para cancelar ou reabrir.');return;}}else{try{checkTransition(kind,record.status,nextStatus,reason);}catch{setError('Informe um motivo com pelo menos três caracteres para cancelar ou reabrir.');return;}}
    void run(`/v1/documentos/${kind}/${record.id}/status`,'POST',{expected_version:record.version,status:nextStatus,reason:reason||null});};
  // Origin "Gerar venda" / "Gerar ordem de serviço" (vendas.php#idOrigem/<id>): the new document opens prefilled; saving it concludes the proposta.
  const reviewConversion=(target:ConversionKind)=>{if(!record||kind!=='sales_proposals'||['completed','cancelled'].includes(record.status)||record.template||!writable||!mayAct(true))return;setError('');const id=record.id;guard.confirmLeave(()=>navigate(`/documentos-empresa?${new URLSearchParams({tipo:target,acao:'proposta',origem:id})}`));};
  const acceptFinanceDocument=(saved:DocumentRecord)=>{if(pending.current||live.current.documentBusy||childConflict('finance'))throw new AccessError(409);if(!record||saved.id!==record.id||saved.kind!==kind||!Number.isInteger(saved.version)||saved.version<record.version)throw new AccessError(502);onSaved(saved);};
  const reloadAfterReservation=async(version:number)=>{if(!record)return;const authorized=()=>{const snapshot=controller.getSnapshot();return plannerMounted.current&&snapshot.phase==='ready'&&snapshot.membership?.user_id===plannerActor.current&&reservationCanRead(snapshot.membership?.role??'');};if(!authorized())throw new AccessError(403);if(pending.current||live.current.documentBusy||childConflict('reservation'))throw new AccessError(409);const request=new AbortController();pending.current=request;try{const response=await controller.documents(`/v1/documentos/${kind}/${record.id}`,{signal:request.signal})as DocumentEnvelope;if(!request.signal.aborted){if(!authorized())throw new AccessError(403);if(response.document.id!==record.id||response.document.kind!==kind||!Number.isInteger(response.document.version)||response.document.version<version)throw new AccessError(502);if(childConflict('reservation'))throw new AccessError(409);onSaved(response.document);}}finally{if(pending.current===request)pending.current=null;}};
  const reloadAfterReceipt=async(version:number)=>{if(!record)return;const authorized=()=>{const snapshot=controller.getSnapshot();return plannerMounted.current&&navigationController.current===controller&&snapshot.phase==='ready'&&snapshot.membership?.user_id===plannerActor.current&&purchaseReceiptsAllowed(snapshot.membership?.role??'');};if(!authorized())throw new AccessError(403);if(pending.current||live.current.documentBusy||childConflict('receipt'))throw new AccessError(409);const request=new AbortController();pending.current=request;try{const response=await controller.documents(`/v1/documentos/${kind}/${record.id}`,{signal:request.signal})as DocumentEnvelope;if(request.signal.aborted)throw new DOMException('Request cancelled','AbortError');if(!authorized())throw new AccessError(403);if(response.document.id!==record.id||response.document.kind!==kind||!Number.isInteger(response.document.version)||response.document.version<Math.max(version,record.version))throw new AccessError(502);if(childConflict('receipt'))throw new AccessError(409);onSaved(response.document);}finally{if(pending.current===request)pending.current=null;}};
  const reloadAfterStock=async()=>{if(!record)return;if(pending.current||live.current.documentBusy||childConflict('stock'))throw new AccessError(409);const request=new AbortController();pending.current=request;try{const response=await controller.documents(`/v1/documentos/${kind}/${record.id}`,{signal:request.signal})as DocumentEnvelope;if(!request.signal.aborted){if(response.document.id!==record.id||response.document.kind!==kind||!Number.isInteger(response.document.version)||response.document.version<record.version)throw new AccessError(502);if(childConflict('stock'))throw new AccessError(409);onSaved(response.document);}}finally{if(pending.current===request)pending.current=null;}};
  const refreshForJournal=async()=>{if(!record||!mayAct(true))return;const request=new AbortController();pending.current=request;setBusy(true);setError('');try{const response=await controller.documents(`/v1/documentos/${kind}/${record.id}`,{signal:request.signal})as DocumentEnvelope;if(!request.signal.aborted){if(response.document.id!==record.id||response.document.kind!==kind||!Number.isInteger(response.document.version)||response.document.version<record.version)throw new AccessError(502);if(childHasDraft()||Object.values(children.current).some(value=>value.busy))return;onSaved(response.document);}}catch(failure){if(!request.signal.aborted)setError(errorText(failure));}finally{if(pending.current===request)pending.current=null;if(!request.signal.aborted)setBusy(false);}};
  // Produtos lane (migration 155): fornecedor padrão, preço sugerido e preços do novo fornecedor no pedido de compra.
  const purchasePrices=usePurchasePrices({controller,kind,mayEdit:mayEditBody,values:()=>live.current.values,onItems:items=>patch('items',items),onSupplier:row=>{setContact(row);patch('contact_id',row.id);}});
  // `increment` is the barcode/code entry: like Origin, reading the same product again adds 1 to its last line.
  // 202610200268: in the OS the line goes to the grid where it was chosen (a code read goes by the type of the product).
  // `at` (wave F): the product chosen in the Descrição of that free line replaces it (keeping its quantity).
  const lineSearchable=(item:{product_id?:string|null})=>editable&&!item.product_id&&Boolean(catalogAccess?.read.includes('products'));
  const addProduct=(row:CatalogRecord|null,increment=false,group?:ServiceItemGroup,at?:number):string=>{
    if(!row||!mayEditBody())return 'O documento não está liberado para incluir itens agora. Nenhum item foi incluído.';
    // Only stock products (kind P) have físico/disponível; a service or other kind hides the panel.
    const items=live.current.values.items,shown=()=>setStockProduct(previous=>row.kind==='P'?{id:row.id,name:row.name,seq:(previous?.seq??0)+1}:null);
    if(increment){
      let index=-1;for(let i=items.length-1;i>=0;i--)if(items[i].product_id===row.id){index=i;break;}
      if(index>=0){
        const quantity=incrementQuantity(items[index].quantity);
        if(quantity===null){const message=`Não foi possível somar 1 à quantidade do item ${index+1}: confira a quantidade informada (até nove dígitos inteiros e seis casas decimais). Nenhum item foi alterado.`;setError(message);return message;}
        setError('');patch('items',items.map((item,i)=>i===index?{...item,quantity}:item));shown();return `${row.name}: quantidade do item ${index+1} alterada para ${documentDecimalDisplay(quantity)}.`;
      }
    }
    const replaced=at!==undefined&&items[at]&&!items[at].product_id?items[at]:null;
    if(!replaced&&items.length>=250)return 'O documento já tem 250 itens. Nenhum item foi incluído.';
    const repeated=items.some(item=>item.product_id===row.id);
    if(repeated&&!prefs.repeatedItems){const message=`Item repetido: ${row.name} já está na ordem de serviço, e as Preferências não permitem itens repetidos. Altere a quantidade da linha existente.`;setError(message);return message;}
    let price='';
    if(row.price!==null&&row.price!==undefined){
      try { price=compactDocumentDecimal(normalizeUnitPrice(row.price,10)); }
      catch { const message='O preço deste produto não cabe no documento: são permitidos até dez dígitos inteiros e dez casas decimais. Confira o cadastro ou informe um item livre com preço negociado explícito. Nenhum item foi incluído.';setError(message);return message; }
    }
    const osGroup=kind==='service_orders'?group??(row.kind==='S'?'service':'part'):null;
    const line={...newItem(),product_id:row.id,description:row.name,code:row.code,unit:typeof row.unit==='string'&&row.unit?row.unit:osGroup==='service'?'UN':typeof row.unit==='string'?row.unit:'',unit_price:price,...(kind!=='purchase_orders'&&price?{list_price:price}:{}),...(osGroup?{group:osGroup,quote:false,done:false}:{})};listPrices.current.set(line.id!,row.price);weights.current.set(line.id!,row.gross_weight);
    if(replaced&&replaced.quantity)line.quantity=replaced.quantity;
    setError('');patch('items',replaced?items.map((item,i)=>i===at?line:item):[...(items.length===1&&!items[0].description&&!items[0].product_id?[]:items),line]);shown();purchasePrices.added(line.id!,row.id,price);
    if(priceListRef.current)void priceLine(line.id!,row.id,price);
    if(kind==='purchase_orders'&&live.current.values.contact_id)void supplierCode(line.id!,row.id,live.current.values.contact_id);
    const message=repeated?`Item repetido: ${row.name} já estava no documento e foi incluído em outra linha.`:`${row.name} incluído com quantidade 1.`;setItemNotice(repeated?message:'');
    return message;
  };
  // The list price of one product (null when it is not in the list); late answers never overwrite a price typed meanwhile.
  // 202610200196: the batch lookup of the produtos lane (/listas-precos/{id}/precos), up to 100 products per read.
  const listPricesOf=async(productIds:string[],listId:string,signal?:AbortSignal)=>{const prices=new Map<string,string|null>();
    for(let index=0;index<productIds.length;index+=100){const chunk=productIds.slice(index,index+100);for(const [id,price] of readListPrices(await controller.catalog(listPricesPath(listId,chunk),{signal}),listId,chunk))prices.set(id,price);if(signal?.aborted)break;}
    return prices;};
  const listPriceOf=async(productId:string,listId:string,signal?:AbortSignal)=>(await listPricesOf([productId],listId,signal)).get(productId)??null;
  const priceLine=async(lineId:string,productId:string,expected:string)=>{
    const list=priceListRef.current,actor=controller.getSnapshot().membership?.user_id;if(!list)return;
    try{
      const price=await listPriceOf(productId,list.id);
      if(!plannerMounted.current||priceListRef.current?.id!==list.id||controller.getSnapshot().membership?.user_id!==actor||isLocked()||!mayEditBody())return;
      const items=live.current.values.items,index=items.findIndex(item=>item.id===lineId);
      if(price===null){setItemNotice(`O produto do item ${index+1} não está na lista ${list.name}: ficou o preço de venda.`);return;}
      if(index<0||items[index].unit_price!==expected)return;
      patch('items',items.map((item,i)=>i===index?{...item,unit_price:compactDocumentDecimal(price),list_price:compactDocumentDecimal(price)}:item));setItemNotice(`Preço da lista ${list.name} aplicado ao item ${index+1}.`);
    }catch{if(plannerMounted.current)setItemNotice(`Não foi possível consultar a lista ${list.name}; o item ficou com o preço de venda.`);}
  };
  // "Aplicar a lista aos itens": one read per product line, then a single change of the prices (the save waits for it).
  const applyPriceList=async()=>{
    const list=priceListRef.current;if(!list||pending.current||!mayEditBody())return;
    const request=new AbortController(),actor=controller.getSnapshot().membership?.user_id;pending.current=request;setPricing(`Aplicando a lista ${list.name}…`);setItemNotice('');
    try{
      const products=[...new Set(live.current.values.items.flatMap(item=>item.product_id?[item.product_id]:[]))],prices=products.length?await listPricesOf(products,list.id,request.signal):new Map<string,string|null>();
      if(request.signal.aborted)return;
      if(priceListRef.current?.id!==list.id||controller.getSnapshot().membership?.user_id!==actor)return;
      let changed=0,missing=0;
      const items=live.current.values.items.map(item=>{if(!item.product_id||!prices.has(item.product_id))return item;const price=prices.get(item.product_id);if(price===null||price===undefined){missing+=1;return item;}changed+=1;return {...item,unit_price:compactDocumentDecimal(price),list_price:compactDocumentDecimal(price)};});
      pending.current=null;patch('items',items);
      setItemNotice(`Lista ${list.name}: ${changed} item(ns) com o preço da lista${missing?`, ${missing} fora da lista com o preço atual`:''}.`);
    }catch(failure){if(!request.signal.aborted&&plannerMounted.current)setItemNotice(`Não foi possível aplicar a lista ${list.name}: ${errorText(failure)}`);}
    finally{if(pending.current===request)pending.current=null;if(plannerMounted.current)setPricing('');}
  };
  // 202610200196 pedido de compra: the Código no fornecedor of the vínculo produto-fornecedor fills an empty "Código" of the new line.
  const supplierCode=async(lineId:string,productId:string,contactId:string)=>{
    const actor=controller.getSnapshot().membership?.user_id;
    try{
      const codes=readSupplierCodes(await controller.documents(supplierCodesPath(contactId,[productId])),contactId);
      const code=codes.get(productId);if(!code||!plannerMounted.current||controller.getSnapshot().membership?.user_id!==actor||live.current.values.contact_id!==contactId||isLocked()||!mayEditBody())return;
      const items=live.current.values.items,index=items.findIndex(item=>item.id===lineId);if(index<0||items[index].supplier_code)return;
      patch('items',items.map((item,i)=>i===index?{...item,supplier_code:code}:item));
    }catch{/* The Código stays empty and editable. */}
  };
  // Total do IPI and Total do ICMS ST (Preferências › Propostas "Exibe campos IPI e ST"): the estimate of the note's engine is
  // added to the total of the document (202610200196); equal values never change the form. A saved document only opened (no
  // change yet) keeps its stored taxes: opening it never makes the form dirty nor moves its total away from its parcelas.
  const applyTaxes=(estimate:{ipi:string;icms_st:string}|null)=>{
    if(!estimate||!mayEditBody()||(record&&!live.current.dirty))return;const current=live.current.values;
    const same=(a:string|undefined,b:string)=>compactDocumentDecimal(a??'0')===compactDocumentDecimal(b);
    if(same(current.tax_ipi,estimate.ipi)&&same(current.tax_icms_st,estimate.icms_st))return;
    const next={...current,tax_ipi:estimate.ipi,tax_icms_st:estimate.icms_st};live.current.values=next;live.current.dirty=JSON.stringify(documentFormValues(next))!==JSON.stringify(initial);setValues(next);
  };
  const openQuickContact=(query:string|QuickContactValues)=>{if(!contactCreatable||quickOpen.current||!mayEditBody())return;quickOpen.current=true;setContactStatus('');setQuickState({busy:false,dirty:false,uncertain:false});setQuickContact(typeof query==='string'?quickContactInitial(kind,query):query);};
  const closeQuickContact=(message:string)=>{quickOpen.current=false;setQuickContact(null);setQuickState({busy:false,dirty:false,uncertain:false});setContactStatus(message);};
  const quickContactCreated=(row:CatalogRecord)=>{
    if(!quickOpen.current)return;
    // The new contact goes through the same guarded patch as a manual choice; other unsaved edits stay.
    if(!mayEditBody()){closeQuickContact(`Contato ${row.name} cadastrado. O documento não está liberado para edição agora; selecione-o depois no campo ${kind==='purchase_orders'?'Fornecedor':'Cliente'}.`);return;}
    closeQuickContact(`Contato ${row.name} cadastrado e selecionado.`);setContact({id:row.id,name:row.name});patch('contact_id',row.id);setError('');
  };
  const deliveryDays=values.commercial?.transport?.delivery_days??'';
  // Origin: in the pedido the prazo de entrega plus the Cross-Docking (Preferências › Estoque) gives the data prevista.
  const setDeliveryDays=(text:string)=>{const current=values.commercial??emptyCommercial(),transport=current.transport??emptyTransport();patch('commercial',{...current,transport:{...transport,delivery_days:text.trim()?text.trim():null}});
    const expected=kind==='sales_orders'?crossDockedDate(live.current.values.date,text,settings?.cross_docking_days??0):null;if(expected)patch('expected_date',expected);};
  const generateInstallments=async()=>{if(!mayEditBody())return;
    // Origin "Forma de pagamento cadastrada": its condição padrão gives the parcelas, which take that forma (202610200196).
    const typed=condition||live.current.values.payment_terms||'',known=paymentOptions??(/^[\d\s,;/+xX]*$/.test(typed)?null:restrictOptions(await paymentSource.load()));
    if(!plannerMounted.current||!mayEditBody())return;
    try{const current=live.current.values,base=(installmentBase==='date'?current.date:current[installmentBase])||'';
    const registered=methodCondition(typed,known?.methods??[]);
    const planned=conditionInstallments(current,registered?.condition??(condition||current.payment_terms||''),base,{baseLabel:installmentBase==='date'?null:BASE_LABELS[installmentBase],freightFirst:prefs.freightFirstInstallment});
    const installments=registered?planned.map(row=>withMethod(row,registered.method,kind)):planned;patch('installments',installments);if(!live.current.values.payment_terms&&condition)patch('payment_terms',condition);setError('');}catch(failure){setError(failure instanceof Error?failure.message:'Confira a condição de pagamento.');}};
  const move=(index:number,delta:number)=>{const items=[...values.items];const target=index+delta;if(target<0||target>=items.length)return;[items[index],items[target]]=[items[target],items[index]];patch('items',items);};
  // EST-033: the parts of the Identificação; the pedido de compra shows the Fornecedor first and the rest as "Detalhes da compra" after the totals.
  const identDate=<div className="form-field"><label htmlFor="doc-date">{kind==='sales_orders'?'Data da venda *':kind==='service_orders'&&prefs.labels.data_entrada?`${prefs.labels.data_entrada} *`:'Data *'}</label><input id="doc-date" type="date" min="1900-01-01" max="2099-12-31" required value={values.date} {...invalidProps('doc-date')} onChange={event=>patch('date',event.target.value)}/></div>;
  // The contact helpers stay in the Cliente cell instead of becoming cells of the Identificação grid.
  const identContact=<><div className="document-contact-field"><CatalogPicker controller={controller} entity="contacts" label={`${contactLabel} *`} contactTools={{history:kind==='purchase_orders'?'purchase_orders':'sales_orders'}} selected={contact} disabled={!editable||stockEditable||busy||uncertain} invalid={invalid.includes('doc-contact')} onCreate={contactCreatable?openQuickContact:undefined} status={contactStatus} onSelect={row=>{if(!mayEditBody())return;setContactStatus('');setContact(row?{id:row.id,name:row.name}:null);setContactState(row&&typeof row.state==='string'?row.state:null);patch('contact_id',row?.id||'');purchasePrices.supplierChanged(row?{id:row.id,name:row.name}:null);}}/><div className="document-contact-helpers">{values.contact_id&&catalogAccess?.write.includes('contacts')&&<a href="#" role="button" className="text-button document-contact-edit-open" title="Editar Contato" onClick={event=>{event.preventDefault();setContactEdit(true);}}><Icon name="pencil" size={12}/><span>Editar contato</span></a>}{editable&&!stockEditable&&catalogAccess?.read.includes('contacts')&&<button type="button" className="text-button document-contact-search-open" title="Abre a busca avançada de cadastros" onClick={()=>setContactSearch(true)}><Icon name="magnifying-glass" size={13}/><span>Busca avançada</span></button>}{kind!=='purchase_orders'&&values.contact_id&&<a href="#" role="button" className="text-button document-history-open" title="Visualizar histórico do cliente" onClick={event=>{event.preventDefault();setHistory({mode:'client'});}}><Icon name="circle-info" size={14}/><span>Visualizar histórico do cliente</span></a>}</div></div>{(kind==='sales_orders'||kind==='sales_proposals')&&editable&&catalogAccess?.read.includes('products')&&<DocumentPriceList controller={controller} contact={values.contact_id?{id:values.contact_id,state:contactState}:null} seller={values.seller_id||null} paymentMethods={(values.installments??[]).map(row=>row.payment_method_id).filter((id):id is string=>Boolean(id))} selected={priceList} disabled={!editable||busy||uncertain} busy={pricing} applicable={values.items.filter(item=>item.product_id).length} onSelect={(list,reason)=>{if(!mayEditBody())return;setPriceList(list);setPriceListNotice(reason??'');patch('price_list_id',list?.id??null);}} onApply={()=>void applyPriceList()}/>}{!editable&&priceList&&<p className="documents-picked"><span>Lista de preço: {priceList.name}</span></p>}{priceListNotice&&<p className="real-notice" role="status">{priceListNotice}</p>}</>;
  const identRest=<>{catalogAccess?.read.includes('warehouses')&&(kind!=='purchase_orders'||Boolean(values.warehouse_id))&&<CatalogPicker controller={controller} entity="warehouses" label="Depósito previsto" selected={warehouse} disabled={kind==='purchase_orders'||!editable||stockEditable||busy||uncertain} onSelect={row=>{if(!mayEditBody())return;setWarehouse(row?{id:row.id,name:row.name}:null);patch('warehouse_id',row?.id||null);}}/>}<div className="form-field"><label htmlFor="doc-expected">Data prevista</label><input id="doc-expected" type="date" value={values.expected_date||''} onChange={event=>patch('expected_date',event.target.value||null)}/></div>
        {/* The reviewed copy keeps the automatic number: erp_document_copy (129) does not take a requested one. */}
        {prefs.numberEditable&&writable&&!copyDraft&&(!record||editable&&!stockEditable)&&<div className="form-field"><label htmlFor="doc-number">{kind==='sales_orders'?'Número do pedido':'Número'}</label><input id="doc-number" inputMode="numeric" maxLength={10} title="Editável pelas Preferências; deixe o número sugerido para a numeração automática." value={values.number??record?.number??nextNumber??''} {...invalidProps('doc-number')} onChange={event=>{const text=event.target.value.trim(),original=record?.number??nextNumber;patch('number',text===''&&!record?undefined:text===original?undefined:text);}}/></div>}
        {sellerKind&&(writable||values.seller_id)&&<DocumentSellerPicker controller={controller} id="doc-seller" label="Vendedor" required={prefs.sellerRequired&&!(kind==='sales_proposals'&&values.template)} selected={seller} disabled={!editable||busy||uncertain} invalid={invalid.includes('doc-seller')} onSelect={row=>{if(!mayEditBody())return;setSeller(row);patch('seller_id',row?.id??null);}}/>}
        {kind==='sales_orders'&&<DocumentOptionalSection mode={prefs.showDetails} label="detalhes da venda" filled={Boolean((record?values.ship_date:values.ship_date&&values.ship_date!==initial.ship_date)||values.customer_po_number)}><div className="form-field"><label htmlFor="doc-ship-date">Data saída</label><input id="doc-ship-date" type="date" min="1900-01-01" max="2099-12-31" title="Data que foi despachado" value={values.ship_date||''} onChange={event=>patch('ship_date',event.target.value||null)}/></div><div className="form-field"><label htmlFor="doc-customer-po">Pedido de compra</label><input id="doc-customer-po" maxLength={60} title="Número do pedido de compra do cliente" value={values.customer_po_number||''} onChange={event=>patch('customer_po_number',event.target.value||null)}/></div></DocumentOptionalSection>}
        {kind==='purchase_orders'&&<div className="form-field"><label htmlFor="doc-order-reference">Ordem de compra</label><input id="doc-order-reference" maxLength={100} title="Número da ordem de compra" value={values.order_reference||''} onChange={event=>patch('order_reference',event.target.value||null)}/></div>}
        {kind==='service_orders'&&<><div className="form-field"><label htmlFor="doc-finish-date">Data término</label><input id="doc-finish-date" type="date" min="1900-01-01" max="2099-12-31" value={values.finish_date||''} onChange={event=>patch('finish_date',event.target.value||null)}/></div><div className="form-field"><label htmlFor="doc-ship-date">Data de Saída</label><input id="doc-ship-date" type="date" min="1900-01-01" max="2099-12-31" title="Data de retirada da peça" value={values.ship_date||''} onChange={event=>patch('ship_date',event.target.value||null)}/></div>{([['start_time','Hora de Início'],['end_time','Hora de término']] as const).map(([key,label])=><div className="form-field" key={key}><label htmlFor={`doc-${key}`}>{label}</label><input id={`doc-${key}`} type="time" value={values[key]||''} onChange={event=>patch(key,event.target.value||null)}/></div>)}</>}{kind==='sales_proposals'&&<><div className="form-field"><label htmlFor="doc-valid-days">Validade da proposta (dias)</label><input id="doc-valid-days" inputMode="numeric" maxLength={4} value={values.valid_until&&values.date?daysFrom(values.date,values.valid_until):''} onChange={event=>{const due=event.target.value.trim()?dueFromDays(values.date,event.target.value):null;if(!event.target.value.trim())patch('valid_until',null);else if(due)patch('valid_until',due);}}/></div><div className="form-field"><label htmlFor="doc-valid">Validade</label><input id="doc-valid" type="date" value={values.valid_until||''} onChange={event=>patch('valid_until',event.target.value||null)}/></div><div className="form-field"><label htmlFor="doc-next">{nextContactRequired?'Próximo contato *':'Próximo contato'}</label><input id="doc-next" type="date" value={values.next_contact||''} {...invalidProps('doc-next')} onChange={event=>patch('next_contact',event.target.value||null)}/></div><label className="document-check"><input type="checkbox" checked={values.template||false} onChange={event=>patch('template',event.target.checked)}/>Salvar como modelo</label>{values.template&&<div className="form-field"><label htmlFor="doc-template-name">Nome do modelo:</label><input id="doc-template-name" maxLength={120} value={values.template_name||''} onChange={event=>patch('template_name',event.target.value||null)}/></div>}</>}</>;
  const identDetails=record&&<div className="document-details"><h3>{DETAILS_TITLES[kind]}</h3><p>Cadastrada em: {registeredAt(record.created_at)}</p>{record.source_proposal_id&&!copyDraft&&<DocumentProposalNumber controller={controller} proposalId={record.source_proposal_id} disabled={busy||uncertain} onOpen={()=>{if(isLocked())return;guard.confirmLeave(()=>navigate(`/documentos-empresa?${new URLSearchParams({tipo:'sales_proposals',documento:record.source_proposal_id!})}`));}}/>}{kind==='sales_orders'&&!copyDraft&&<PdvOrderOrigin controller={controller} documentId={record.id}/>}</div>;
  const commercialFields=<DocumentCommercialFields value={values.commercial??null} disabled={!editable||busy||uncertain} onChange={value=>patch('commercial',value)} transportMode={prefs.showCarrier} computedWeight={computedWeight} purchase={kind==='purchase_orders'} weightDecimals={settings?.weight_decimals??null}
        carrierFilled={Boolean(values.carrier_id)} carrier={kind!=='service_orders'&&(catalogAccess?.read.includes('contacts')?<CatalogPicker controller={controller} entity="contacts" label="Transportador" contactTools={{role:'carrier'}} selected={carrier} disabled={!editable||busy||uncertain} onSelect={row=>{if(!mayEditBody())return;setCarrier(row?{id:row.id,name:row.name}:null);patch('carrier_id',row?.id??null);}}/>:carrier&&<p className="documents-picked"><span>Transportador: {carrier.name}</span></p>)}/>;
  return <section className="real-editor" aria-labelledby="document-editor-title">{purchasePrices.dialog}<header className="real-editor-heading"><div><h2 id="document-editor-title" ref={heading} tabIndex={-1}>{record?`${FORM_TITLES[kind]} - ${documentLabel(record)}`:nextNumber?`${FORM_TITLES[kind]} - ${nextNumber}`:FORM_TITLES[kind]}</h2><p>{record?<><DocumentStatusBadge kind={kind} status={record.status} situation={recordSituation}/><button type="button" className="documents-occurrence-clock" title="Visualizar ocorrências" aria-label="Visualizar ocorrências" disabled={busy||uncertain||dirty||childDraft} onClick={()=>{if(mayAct(true))setOccurrencesOpen(true);}}><Icon name="clock" size={12}/></button>{` · versão ${record.version}`}{kind==='purchase_orders'&&<small className="document-registered-at">{` · Cadastrado em: ${registeredAt(record.created_at)}`}</small>}{(effects.stock||effects.finance||record.source_proposal_id)&&<span className="document-indicators">{record.source_proposal_id&&<IndicatorLetter text="P" color="red" title="Gerado a partir de uma proposta comercial"/>}{effects.finance&&<IndicatorLetter text="C" color="green" title="Contas lançadas"/>}{effects.stock&&<IndicatorLetter text="E" color="blue" title="Estoque lançado"/>}</span>}</>:nextNumber?'Próximo número; confirmado ao salvar':'Número atribuído ao salvar'}</p></div><div className="document-editor-buttons"><div><button type="button" className="secondary-button" title={copyDraft?'Voltar ao documento de origem sem salvar a cópia':'Voltar à listagem'} disabled={busy||uncertain} onClick={()=>{if(isLocked())return;guard.confirmLeave(onClose);}}>Cancelar</button>{(editable||notesOnly)&&(kind==='sales_proposals'&&record?<span className="document-save-split"><button type="submit" form="document-editor-form" className="primary-button" disabled={busy||uncertain}>{busy?'Salvando…':'Salvar'}</button>
          <button type="button" className="primary-button document-save-more" aria-label="Mais opções de salvar" aria-haspopup="menu" aria-expanded={saveMenu} disabled={busy||uncertain} onClick={()=>setSaveMenu(open=>!open)}><Icon name="chevron-down" size={10}/></button>
          {saveMenu&&<div className="document-save-menu" role="menu" aria-label="Opções de salvar">{/* 202610200269 Origin chevron of the Salvar of the proposta. */}
            <button type="button" role="menuitem" disabled={Boolean(record.template)||childDraft} title={record.template?'Modelos não têm versões.':'Grava o formulário como uma nova versão da proposta; a versão atual fica só para consulta.'} onClick={()=>{setSaveMenu(false);submit({preventDefault(){}} as FormEvent,true);}}>Salvar nova versão</button>
            <button type="button" role="menuitem" disabled={dirty||childDraft||Boolean(conversionReview)} title={dirty?'Salve as alterações antes de imprimir.':undefined} onClick={()=>{setSaveMenu(false);if(mayAct(true)){setPrintTechnician(false);setPrintOpen(true);}}}>Imprimir</button>
            <button type="button" role="menuitem" disabled={!writable||dirty||childDraft||Boolean(nextStatus||reason||conversionReview)} onClick={()=>{setSaveMenu(false);void prepareCopy();}}>Clonar</button>
            <button type="button" role="menuitem" disabled={!writable||dirty||childDraft||Boolean(nextStatus||reason||conversionReview)} onClick={()=>{setSaveMenu(false);void prepareCopy(true);}}>Usar este como modelo</button></div>}</span>
          :<button type="submit" form="document-editor-form" className="primary-button" disabled={busy||uncertain}>{busy?'Salvando…':'Salvar'}</button>)}</div>{editable&&<small>(*) Campos obrigatórios</small>}</div></header>
    {error&&<p className="real-alert" role="alert">{error}</p>}{uncertain&&<div className="real-editor-actions"><button type="button" className="primary-button" disabled={busy} onClick={()=>void execute()}>{busy?'Conferindo…':'Conferir resultado'}</button></div>}{superseded&&record?.proposal_version&&<p className="real-notice document-version-notice" role="note">Esta é a versão {record.proposal_version.label} da proposta. A versão mais nova é a {record.proposal_version.latest.label}; as versões anteriores ficam só para consulta. <button type="button" className="text-button" onClick={()=>{const latest=record.proposal_version!.latest.id;if(isLocked())return;guard.confirmLeave(()=>navigate(`/documentos-empresa?${new URLSearchParams({tipo:'sales_proposals',documento:latest})}`));}}>Abrir a versão {record.proposal_version.latest.label}</button></p>}
    {notesOnly&&<DocumentNotesNotice kind={kind} effects={{finance:effects.finance,stock:effects.stock||receiptActive===true,reservation:reservationActive===true,originFinance:effects.originFinance&&!effects.finance,originInvoice:effects.originInvoice}} onOpen={target=>document.getElementById(target)?.scrollIntoView({behavior:'smooth',block:'start'})}/>}
    {record&&!editable&&!superseded&&!notesOnly&&<p className="real-notice">{reservationEnabled&&reservationActive===null?'Conferindo reservas antes de liberar a edição.':reservationActive?'Existe uma reserva ativa. Libere-a antes de alterar os itens ou o depósito.':childDraft?'Conclua ou descarte a conferência aberta antes de editar o documento.':effectsUnknown?'Não foi possível conferir os vínculos operacionais. Reabra o documento para atualizar.':effects.active?`Existe lançamento ativo ${effects.finance&&effects.stock?'no financeiro e no estoque':effects.finance?'no financeiro':'no estoque'}. A equipe autorizada precisa conferir o estorno antes de corrigir o documento.`:(financeEnabled&&financeActive===null)||(stockEnabled&&stockActive===null)?'Conferindo os vínculos antes de liberar a edição.':writable?'A situação atual bloqueia a edição. Use uma transição permitida para reabrir, quando disponível.':'Seu perfil permite consultar este documento.'}</p>}
    {copyDraft&&<DocumentCopyNotice preview={copyDraft.preview}/>}
    {imported&&<div className="real-notice document-xml-notice" role="note">{imported.notices.map(text=><p key={text}>{text}</p>)}{imported.quick&&contactCreatable&&!values.contact_id&&<button type="button" className="secondary-button" disabled={!editable||busy||uncertain} onClick={()=>openQuickContact(imported.quick!)}>{kind==='purchase_orders'?'Cadastrar fornecedor do XML':'Cadastrar cliente do XML'}</button>}</div>}
    {record&&!copyDraft&&<DocumentContactCheck controller={controller} kind={kind} contactId={record.contact_id} savedName={record.contact_snapshot.name}/>}
    {record&&!copyDraft&&kind==='sales_orders'&&record.status!=='cancelled'&&<DocumentPendencies controller={controller} documentId={record.id} version={record.version}/>}
    {record&&<section className="document-section document-origin-strip" aria-label="Origem e duplicação"><DocumentCopyOrigin request={controller.documentCopy} record={record} blocked={busy||uncertain} onOpen={id=>{if(isLocked())return;guard.confirmLeave(()=>navigate(`/documentos-empresa?${new URLSearchParams({tipo:kind,documento:id})}`));}}/>{writable&&<><button type="button" className="secondary-button" disabled={busy||uncertain||dirty||childDraft||Boolean(nextStatus||reason||conversionReview)} onClick={()=>void prepareCopy()}>Duplicar como novo</button><p className="real-help">Abre uma cópia para conferir antes de salvar; o documento atual permanece inalterado.</p></>}</section>}
    <form id="document-editor-form" onSubmit={submit} onKeyDown={addLineShortcut} aria-busy={busy} noValidate>{kind==='purchase_orders'?<fieldset disabled={!editable||busy||uncertain} className="document-section"><legend>Fornecedor</legend><div className="document-grid">{identContact}</div></fieldset>
      :<fieldset disabled={!editable||busy||uncertain} className="document-section"><legend>Identificação</legend><div className="document-grid">{identDate}{identContact}{identRest}</div>{identDetails}</fieldset>}
      {kind==='service_orders'&&receptionSummary&&<section className="document-section document-reception-summary" aria-label="Resumo do recebimento"><h3>Resumo do recebimento</h3><dl className="commercial-dates">{([[contactLabel,record?.contact_snapshot.name??''],[prefs.labels.equipamento??'Equipamento',values.equipment||''],[prefs.labels.problema??'Problema',values.defect||''],[prefs.labels.observacoes_recebimento??'Observações do recebimento',values.reception_notes||'']] as const).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value||'—'}</dd></div>)}</dl><button type="button" className="text-button" onClick={()=>setReceptionOpen(true)}>Editar dados do recebimento</button></section>}
      {kind==='service_orders'&&!receptionSummary&&<fieldset disabled={!editable||busy||uncertain} className="document-section"><legend>Atendimento</legend><div className="document-grid"><div className="form-field document-wide"><label htmlFor="doc-equipment">{prefs.labels.equipamento??'Equipamento'}</label><textarea id="doc-equipment" rows={2} maxLength={4000} value={values.equipment||''} onChange={event=>patch('equipment',event.target.value)}/></div>{([['serial_number',prefs.labels.numero_serie??'Número de série',100],['technician','Técnico',200]] as const).map(([key,label,max])=><div className="form-field" key={key}><label htmlFor={`doc-${key}`}>{label}</label><input id={`doc-${key}`} maxLength={max} list={key==='technician'?'doc-technician-options':undefined} title={key==='technician'?'Escolha um contato do tipo Técnico ou digite o nome.':undefined} value={values[key]||''} onChange={event=>patch(key,event.target.value)}/>{key==='technician'&&<TechnicianOptions controller={controller} id="doc-technician-options"/>}</div>)}<div className="form-field document-wide"><label htmlFor="doc-reception-notes">{prefs.labels.observacoes_recebimento??'Observações do recebimento'}</label><textarea id="doc-reception-notes" rows={3} maxLength={4000} value={values.reception_notes||''} onChange={event=>patch('reception_notes',event.target.value||null)}/></div>{([['defect',prefs.labels.problema??'Problema'],['solution','Informações técnico']] as const).map(([key,label])=><div className="form-field document-wide" key={key}><label htmlFor={`doc-${key}`}>{label}</label><textarea id={`doc-${key}`} rows={3} maxLength={4000} value={values[key]||''} onChange={event=>patch(key,event.target.value)}/></div>)}</div></fieldset>}
      <fieldset disabled={!editable||stockEditable||busy||uncertain} className="document-section" onPointerEnter={LOT_KINDS.includes(kind)?()=>setLotsWanted(true):undefined} onFocus={LOT_KINDS.includes(kind)?()=>setLotsWanted(true):undefined}><legend>{kind==='service_orders'?'Peças e serviços':kind==='purchase_orders'?'Itens do pedido de compra':'Itens'}</legend>{stockEditable&&<p className="real-notice">Estoque lançado: os itens, o fornecedor e o depósito ficam somente leitura; os demais campos podem ser alterados. Para mudá-los, estorne o estoque.</p>}{editable&&!stockEditable&&kind!=='service_orders'&&<div className="document-add-item">{catalogAccess?.read.includes('products')&&values.items.length<250&&<CatalogPicker controller={controller} entity="products" label="Adicionar produto do cadastro" disabled={!editable||busy||uncertain} onSelect={row=>addProduct(row)} onCode={row=>addProduct(row,true)} stockWarehouse={stockReadable?values.warehouse_id||null:undefined}/>}{prefs.freeItems?<button type="button" className="text-button document-add-line" disabled={values.items.length>=250} title="Inclui uma linha vazia para um item não cadastrado (Alt+Z)" aria-keyshortcuts="Alt+Z" onClick={()=>patch('items',[...values.items,newItem()])}>+ Adicionar outro item</button>:<small className="real-help">Não é permitido vender produtos não cadastrados (Preferências › Vendas).</small>}</div>}
        {itemNotice&&<p className="real-notice" role="status">{itemNotice}</p>}
        {editable&&!stockEditable&&autoProducts&&<p className="real-help">Itens não cadastrados viram produtos do cadastro ao salvar (Preferências › Cadastros › Produtos). Um código igual ao de um produto ativo liga o item a ele.</p>}
        {editable&&mySeller&&Number(mySeller.discount_limit)>0&&kind!=='purchase_orders'&&<p className="real-help">Limite de desconto do vendedor: {mySeller.discount_limit.replace(/\.?0+$/,'').replace('.',',')}%.</p>}
        {editable&&stockReadable&&stockProduct&&<DocumentProductStock controller={controller} product={stockProduct} warehouseId={values.warehouse_id||null}/>}
        {kind==='service_orders'?<ServiceOrderItems items={values.items} totals={totals} editable={editable} labels={prefs.labels} listPrice={listPriceColumn} discount={lineDiscount} listPriceOf={listPriceOfLine}
          priceTitle="Até dez dígitos inteiros e dez casas decimais; sem arredondar o preço." priceMaxLength={UNIT_PRICE_INPUT_LIMIT} invalidProps={invalidProps} onChange={changeItem}
          onRemove={index=>patch('items',live.current.values.items.filter((_,i)=>i!==index))} onSwap={(a,b)=>{const items=[...live.current.values.items];[items[a],items[b]]=[items[b]!,items[a]!];patch('items',items);}}
          onAddFree={group=>patch('items',[...live.current.values.items,osLine(group)])} freeItems={prefs.freeItems} full={values.items.length>=250} quantityPlaces={quantityPlaces(settings)} warrantyEnd={days=>warrantyUntil({...values,warranty_days:days},prefs.print.warrantyBase)}
          commissions={rows=><DocumentItemCommissions controller={controller} kind={kind} sellerId={values.seller_id} documentId={record?.id??null} rows={rows} items={values.items} totals={totals}/>}
          picker={group=>catalogAccess?.read.includes('products')?<CatalogPicker controller={controller} entity="products" label={group==='part'?'Adicionar peça do cadastro':'Adicionar serviço do cadastro'} productKind={group==='part'?'P':'S'} placeholder={group==='part'?'Digite parte do nome ou código da peça':'Digite parte do nome ou código do serviço'} disabled={!editable||busy||uncertain} onSelect={row=>addProduct(row,false,group)} onCode={row=>addProduct(row,true)} stockWarehouse={group==='part'&&stockReadable?values.warehouse_id||null:undefined}/>:null}
          lineTools={(item,index)=><>{item.product_id&&values.contact_id&&<a href="#" role="button" className="text-button document-item-history" aria-label={`Visualizar histórico do item ${index+1} para o cliente`} title="Visualizar histórico do item para o cliente" onClick={event=>{event.preventDefault();setHistory({mode:'item',productId:item.product_id!,label:item.description});}}><Icon name="clock-rotate-left" size={12}/></a>}{item.product_id&&stockReadable&&itemGroup(item)==='part'&&<a href="#" role="button" className="text-button document-item-stock" aria-label={`Todos os depósitos do item ${index+1}`} title="Todos os depósitos" onClick={event=>{event.preventDefault();setItemStock({productId:item.product_id!,description:item.description,code:item.code??null,quantity:item.quantity});}}><Icon name="cubes" size={12}/></a>}{record&&item.product_id&&item.id&&stockReadable&&(effects.stock||receiptActive===true)&&<a href="#" role="button" className="text-button document-item-lots" aria-label={`Informações de lote lançado do item ${index+1}`} title="Informações de lote lançado" onClick={event=>{event.preventDefault();setItemLots({productId:item.product_id!,description:item.description});}}><Icon name="box" size={12}/></a>}{kitItem(item)&&<a href="#" role="button" className="text-button document-item-kit" aria-label={`Editar componentes do produto do item ${index+1}`} title="Editar componentes do produto" onClick={event=>{event.preventDefault();setItemKit(item.id!);}}><Icon name="pencil" size={12}/></a>}{lotLink(item,index)}</>}/>:<><div className="table-scroll" tabIndex={0} aria-label="Itens do documento"><table className="data-table document-items"><thead><tr><th>#</th><th>Descrição / código</th>{kind==='purchase_orders'&&<th>Código</th>}<th>Un</th><th>Quantidade</th>{listPriceColumn&&<th>Preço lista</th>}<th>Preço un</th>{kind==='purchase_orders'&&<th>IPI %</th>}{lineDiscount&&<th>Desc (%)</th>}<th>Preço total</th>{editable&&!stockEditable&&<th>Ações</th>}</tr></thead><tbody>{values.items.map((item,index)=>{const detailKey=item.id||String(index),detailShown=detailOpen.has(detailKey)||Boolean(item.detailed_description),below=Boolean(item.product_id&&item.id)&&belowListPrice(item.unit_price,listPriceOfLine(item));return <tr key={item.id||index}><td className="document-item-position">{index+1}</td><td><input id={`doc-item-description-${index}`} aria-label={`Descrição do item ${index+1}`} maxLength={200} required value={item.description} {...invalidProps(`doc-item-description-${index}`)} {...(lineSearchable(item)?{placeholder:PRODUCT_SEARCH_PLACEHOLDER,'aria-autocomplete':'list' as const,'aria-controls':`doc-item-suggest-${index}`,...(kind!=='purchase_orders'?{title:LINE_SEARCH_INFO}:{})}:{})} onFocus={()=>{if(lineBlur.current)clearTimeout(lineBlur.current);setLineSearch({index,typed:false});}} onBlur={()=>{lineBlur.current=setTimeout(()=>setLineSearch(null),150);}} onKeyDown={event=>{if(lineSearch?.index===index)lineKeys.current?.(event);}} onChange={event=>{setLineSearch({index,typed:true});changeItem(index,{description:event.target.value});}}/>{lineSearchable(item)&&<DocumentLineSuggestions controller={controller} kind={kind} index={index} query={item.description} open={lineSearch?.index===index&&lineSearch.typed} keys={lineKeys} onPick={row=>{setLineSearch(null);addProduct(row,false,undefined,index);}} onClose={()=>setLineSearch(current=>current&&{...current,typed:false})}/>}<input aria-label={kind==='purchase_orders'?`Código SKU do item ${index+1}`:`Código do item ${index+1}`} maxLength={100} placeholder={kind==='purchase_orders'?'Código SKU':'Código'} readOnly={Boolean(item.product_id)} title={item.product_id?'Código do cadastro (somente leitura)':undefined} value={item.code||''} onChange={event=>{if(!item.product_id)changeItem(index,{code:event.target.value||null});}}/><small>{item.product_id?'Vinculado ao cadastro':'Item livre'}</small>{/* Read-only consultations stay available while the form is locked: links, never disabled by the fieldset. */}{item.product_id&&(kind==='purchase_orders'||values.contact_id)&&<a href="#" role="button" className="text-button document-item-history" aria-label={kind==='purchase_orders'?`Visualizar histórico do produto do item ${index+1}`:`Visualizar histórico do item ${index+1} para o cliente`} title={kind==='purchase_orders'?'Visualizar histórico do produto':'Visualizar histórico do item para o cliente'} onClick={event=>{event.preventDefault();setHistory({mode:kind==='purchase_orders'?'purchase':'item',productId:item.product_id!,label:item.description});}}><Icon name="clock-rotate-left" size={12}/></a>}{item.product_id&&stockReadable&&<a href="#" role="button" className="text-button document-item-stock" aria-label={`Todos os depósitos do item ${index+1}`} title="Todos os depósitos" onClick={event=>{event.preventDefault();setItemStock({productId:item.product_id!,description:item.description,code:item.code??null,quantity:item.quantity});}}><Icon name="cubes" size={12}/></a>}{record&&item.product_id&&item.id&&stockReadable&&(effects.stock||receiptActive===true)&&<a href="#" role="button" className="text-button document-item-lots" aria-label={`Informações de lote lançado do item ${index+1}`} title="Informações de lote lançado" onClick={event=>{event.preventDefault();setItemLots({productId:item.product_id!,description:item.description});}}><Icon name="box" size={12}/></a>}{kitItem(item)&&<a href="#" role="button" className="text-button document-item-kit" aria-label={`Editar componentes do produto do item ${index+1}`} title="Editar componentes do produto" onClick={event=>{event.preventDefault();setItemKit(item.id!);}}><Icon name="pencil" size={12}/></a>}{lotLink(item,index)}<button type="button" className="text-button document-detail-toggle" aria-expanded={detailShown} aria-controls={`doc-item-detail-${index}`} onClick={()=>setDetailOpen(previous=>{const next=new Set(previous);if(next.has(detailKey))next.delete(detailKey);else next.add(detailKey);return next;})}>Descrição detalhada</button><label className={`document-item-detail${detailShown?'':' is-collapsed'}`} htmlFor={`doc-item-detail-${index}`}>Descrição detalhada<textarea id={`doc-item-detail-${index}`} maxLength={4000} rows={2} value={item.detailed_description??''} onChange={event=>changeItem(index,{detailed_description:event.target.value||null})}/></label></td>{kind==='purchase_orders'&&<td><input id={`doc-item-supplier-code-${index}`} aria-label={`Código no fornecedor do item ${index+1}`} maxLength={100} title="Código do produto no fornecedor" value={item.supplier_code??''} onChange={event=>changeItem(index,{supplier_code:event.target.value||null})}/></td>}<td><input id={`doc-item-unit-${index}`} aria-label={`Unidade do item ${index+1}`} maxLength={16} placeholder="UN" required value={item.unit} {...invalidProps(`doc-item-unit-${index}`)} onChange={event=>changeItem(index,{unit:event.target.value})}/></td><td><input id={`doc-item-qty-${index}`} aria-label={`Quantidade do item ${index+1}`} type="text" inputMode="decimal" required value={documentDecimalDisplay(item.quantity)} {...invalidProps(`doc-item-qty-${index}`)} onChange={event=>changeItem(index,{quantity:documentDecimalInput(limitedDecimal(event.target.value,quantityPlaces(settings)))})}/></td>{listPriceColumn&&<td className="numeric">{listPriceOfLine(item)!==null?'R$ '+Number(listPriceOfLine(item)).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:4}):'—'}</td>}<td><input id={`doc-item-price-${index}`} aria-label={`Preço do item ${index+1}`} type="text" inputMode="decimal" maxLength={UNIT_PRICE_INPUT_LIMIT} className={below?'document-price-below':undefined} title={below?BELOW_LIST_TITLE:'Até dez dígitos inteiros e dez casas decimais; sem arredondar o preço.'} required value={documentDecimalDisplay(item.unit_price)} {...invalidProps(`doc-item-price-${index}`)} onChange={event=>changeItem(index,{unit_price:documentDecimalInput(event.target.value)})}/></td>{kind==='purchase_orders'&&<td><input id={`doc-item-ipi-${index}`} aria-label={`IPI % do item ${index+1}`} type="text" inputMode="decimal" maxLength={8} placeholder="0" title="Alíquota do IPI do item (%), até 100 com quatro casas decimais" value={documentDecimalDisplay(item.ipi_rate??'')} {...invalidProps(`doc-item-ipi-${index}`)} onChange={event=>{const text=documentDecimalInput(limitedDecimal(event.target.value,4)).trim();changeItem(index,{ipi_rate:text===''?null:text});}}/></td>}{lineDiscount&&<td><input id={`doc-item-discount-${index}`} aria-label={`Desconto do item ${index+1}`} type="text" inputMode="decimal" {...invalidProps(`doc-item-discount-${index}`)} value={documentDecimalDisplay(item.discount_percent)} onChange={event=>changeItem(index,{discount_percent:documentDecimalInput(event.target.value)})}/></td>}<td className="numeric">{decimalMoney(totals?.items[index]?.total??null)}</td>{editable&&!stockEditable&&<td><div className="document-line-actions"><button type="button" aria-label={`Mover item ${index+1} para cima`} disabled={index===0} onClick={()=>move(index,-1)}>↑</button><button type="button" aria-label={`Mover item ${index+1} para baixo`} disabled={index===values.items.length-1} onClick={()=>move(index,1)}>↓</button><button type="button" aria-label={`Remover item ${index+1}`} title={kind==='purchase_orders'?'Remover item do pedido':'Remover item'} onClick={()=>patch('items',values.items.filter((_,i)=>i!==index))}><Icon name="trash-can" size={12}/></button></div></td>}</tr>;})}</tbody></table></div>{!values.items.length&&<p className="real-help">Inclua pelo menos um item antes de salvar.</p>}{kind==='sales_orders'&&<div className="document-item-commissions-toggle"><a href="#" role="button" className="text-button" aria-expanded={commissionsOpen} onClick={event=>{event.preventDefault();setCommissionsOpen(open=>!open);}}>Comissões</a>{commissionsOpen&&<DocumentItemCommissions controller={controller} kind={kind} sellerId={values.seller_id} documentId={record?.id??null} rows={values.items.map((item,index)=>({index,position:index+1,description:item.description}))} items={values.items} totals={totals}/>}</div>}</>}{kind==='service_orders'&&!values.items.length&&<p className="real-help">Nenhum item informado. A OS pode ser recebida para diagnóstico antes de incluir peças ou serviços.</p>}
        <h3 className="document-totals-title">{kind==='purchase_orders'?'Totais da compra':'Totais'}</h3>
        <div className="document-grid document-totals-fields"><div className="form-field"><label htmlFor="doc-item-count">Nº de itens</label><input id="doc-item-count" readOnly value={String(values.items.length)}/></div><div className="form-field"><label htmlFor="doc-qty-sum">{kind==='sales_proposals'?'Soma das qtdes':'Soma das quantidades'}</label><input id="doc-qty-sum" readOnly value={sumOfQuantities===null?'—':documentDecimalDisplay(sumOfQuantities)}/></div>
          <div className="form-field"><label htmlFor="doc-discount_value">Desconto</label><input id="doc-discount_value" type="text" inputMode="decimal" placeholder="Ex: 3,00 ou 10%" title="Ex: 3,00 ou 10%" value={discountDraft} onChange={event=>{const text=event.target.value,next=parseDiscountText(text);if(!mayEditBody())return;setDiscountDraft(text);const updated={...live.current.values,...next};live.current.values=updated;live.current.dirty=JSON.stringify(documentFormValues(updated))!==JSON.stringify(initial);setValues(updated);}}/></div>
          {kind!=='sales_proposals'&&<div className="form-field"><label htmlFor="doc-delivery-days">Prazo de entrega</label><input id="doc-delivery-days" inputMode="numeric" maxLength={6} placeholder="Ex: 3" title="Prazo de entrega, em dia. Ex: 3" value={deliveryDays} onChange={event=>setDeliveryDays(event.target.value)}/></div>}
          {([['freight','Frete (R$)'],['other_expenses','Outras despesas']] as const).filter(([key])=>key!=='other_expenses'||kind!=='purchase_orders'||compactDocumentDecimal(values.other_expenses??'0')!=='0').map(([key,label])=><div className="form-field" key={key}><label htmlFor={`doc-${key}`}>{label}</label><input id={`doc-${key}`} type="text" inputMode="decimal" value={documentDecimalDisplay(values[key])} onChange={event=>patch(key,documentDecimalInput(event.target.value))}/></div>)}
          {/* Leva H (EST-041, 390): Total ICMS ST (campo) of the pedido de compra; it adds to the total like the IPI of the items. */}
          {kind==='purchase_orders'&&<div className="form-field"><label htmlFor="doc-tax-icms-st">Total ICMS ST</label><input id="doc-tax-icms-st" type="text" inputMode="decimal" value={documentDecimalDisplay(values.tax_icms_st??'')} onChange={event=>patch('tax_icms_st',documentDecimalInput(event.target.value))}/></div>}</div>
      </fieldset>
      {/* 202610200270 Origin proposta "Outros itens ou serviços" (Produtos e serviços eventuais ou não cadastrados): texto rico and Total outros itens. */}
      {kind==='sales_proposals'&&<fieldset disabled={!editable||busy||uncertain} className="document-section document-other-items"><legend>Outros itens ou serviços</legend><p className="real-help">Produtos e serviços eventuais ou não cadastrados</p>
        <RichTextEditor id="doc-other-items" label="Outros itens ou serviços" value={values.other_items?.content??null} disabled={!editable||busy||uncertain} onChange={content=>{if(mayEditBody())patch('other_items',otherItemsValue(content,live.current.values.other_items?.total??''));}}/>
        <div className="document-grid"><div className="form-field"><label htmlFor="doc-other-items-total">Total outros itens</label><input id="doc-other-items-total" type="text" inputMode="decimal" placeholder="0,00" value={documentDecimalDisplay(values.other_items?.total??'')} {...invalidProps('doc-other-items-total')} onChange={event=>patch('other_items',otherItemsValue(live.current.values.other_items?.content??null,documentDecimalInput(event.target.value)))}/></div></div></fieldset>}
      <dl className="document-total-summary" aria-live="polite">{kind==='sales_proposals'&&totals?.other_items!==undefined&&<div><dt>Total outros itens</dt><dd>{decimalMoney(totals.other_items)}</dd></div>}{kind==='service_orders'&&osSums&&<><div><dt>Total peças</dt><dd>{decimalMoney(osSums.part)}</dd></div><div><dt>Total serviços</dt><dd>{decimalMoney(osSums.service)}</dd></div></>}<div><dt>{kind==='sales_orders'?'Desconto total da venda':'Desconto total'}</dt><dd>{decimalMoney(totals?.discount??null)}</dd></div>{lineDiscount&&<div><dt>Desconto total dos itens</dt><dd>{decimalMoney(totals?.line_discount??null)}</dd></div>}<div><dt>{kind==='purchase_orders'?'Total dos produtos':'Total dos itens'}</dt><dd>{decimalMoney(totals?.subtotal??null)}</dd></div>{kind==='purchase_orders'&&totals?.ipi!==undefined&&<div><dt>Total do IPI</dt><dd>{decimalMoney(totals.ipi)}</dd></div>}{kind==='purchase_orders'&&totals?.icms_st!==undefined&&totals.icms_st!=='0.00'&&<div><dt>Total ICMS ST</dt><dd>{decimalMoney(totals.icms_st)}</dd></div>}<div className="document-grand-total"><dt>{TOTAL_LABELS[kind]}</dt><dd>{decimalMoney(totals?.total??null)}</dd></div></dl>
      {(kind==='sales_orders'||kind==='sales_proposals')&&<FiscalOrderTaxEstimate controller={controller} kind={kind} contactId={values.contact_id||null} items={values.items} totals={totals} onEstimate={editable?applyTaxes:undefined} applied={Boolean(totals?.ipi!==undefined)}/>}
      {kind==='purchase_orders'&&<fieldset disabled={!editable||busy||uncertain} className="document-section"><legend>Detalhes da compra</legend><div className="document-grid">{identDate}{identRest}</div>{identDetails}</fieldset>}
      {kind==='sales_proposals'&&<fieldset disabled={!editable||busy||uncertain} className="document-section"><legend>Condições gerais</legend><div className="document-grid"><div className="form-field"><label htmlFor="doc-warranty-months">Garantia (meses)</label><input id="doc-warranty-months" inputMode="numeric" maxLength={3} value={values.warranty_months||''} onChange={event=>patch('warranty_months',event.target.value.trim()||null)}/></div><div className="form-field"><label htmlFor="doc-delivery-days">Prazo de entrega</label><input id="doc-delivery-days" inputMode="numeric" maxLength={6} placeholder="Ex: 3" title="Prazo de entrega, em dia. Ex: 3" value={deliveryDays} onChange={event=>setDeliveryDays(event.target.value)}/></div></div></fieldset>}
      {kind==='service_orders'&&<fieldset disabled={!editable||busy||uncertain} className="document-section"><legend>Orçamento e garantia</legend><div className="document-grid">{([['quote_requested','Orçar'],['quoted','Orçado']] as const).map(([key,label])=><label className="document-check" key={key}><input id={`doc-${key}`} type="checkbox" checked={values[key]===true} onChange={event=>patch(key,event.target.checked)}/>{label}</label>)}<div className="form-field"><label htmlFor="doc-warranty-days">Garantia (dias)</label><input id="doc-warranty-days" inputMode="numeric" maxLength={4} placeholder="Ex: 30, 60 ou 90" title="Ex: 30, 60 ou 90" value={values.warranty_days||''} onChange={event=>patch('warranty_days',event.target.value.trim()||null)}/>{warrantyEnd&&<small className="real-help" id="doc-warranty-until">Garantia até {warrantyEnd.split('-').reverse().join('/')} (Preferências › Serviços › Data base da garantia)</small>}</div><div className="form-field document-wide"><label htmlFor="doc-warranty-info">Informações de garantia</label><textarea id="doc-warranty-info" rows={2} maxLength={4000} value={values.warranty_info||''} onChange={event=>patch('warranty_info',event.target.value||null)}/></div></div></fieldset>}
      {kind==='service_orders'&&<DocumentCustomFieldsSection fields={customFields} values={values.custom_fields} disabled={!editable||busy||uncertain} onChange={next=>patch('custom_fields',next)} open={customOpen} onOpen={()=>{setCustomOpen(true);setCustomWanted(true);}}/>}
      {(kind==='sales_orders'||kind==='sales_proposals')&&<DocumentDeliveryAddress value={values.delivery_address??null} disabled={!editable||busy||uncertain} invalid={invalidProps} lookup={controller as unknown as Partial<PlatformPort>} onChange={value=>patch('delivery_address',value)}/>}
      {kind!=='purchase_orders'&&commercialFields}
      {(writable||installmentDraft)&&conditionsInstallments&&<DocumentInstallmentPlanner source={planSource} values={values} total={totals?.total??null} disabled={!mayPlan()} canAct={mayPlan} onDraft={planDraft} onApply={applyPlan}/>}
      <fieldset disabled={!editable||busy||uncertain} className="document-section" onMouseEnter={editable?paymentSource.prefetch:undefined} onFocus={editable?paymentSource.prefetch:undefined}><legend>{kind==='sales_proposals'?'Condições comerciais':kind==='purchase_orders'?'Pagamento':'Condições comerciais e parcelas planejadas'}</legend>{/* 202610200270 Origin proposta "Condições comerciais": Nenhum | Parcela | Texto. */}
        {kind==='sales_proposals'&&<div className="document-conditions-tabs" role="tablist" aria-label="Condições comerciais">{CONDITION_TABS.map(([mode,label])=><button key={mode} type="button" role="tab" aria-selected={conditionsMode===mode} className={conditionsMode===mode?'is-active':undefined} onClick={()=>setConditionsMode(mode)}>{label}</button>)}</div>}
        {kind==='sales_proposals'&&conditionsMode==='none'&&<p className="real-help">Sem condições comerciais nesta proposta.</p>}
        {kind==='sales_proposals'&&conditionsMode==='text'&&<RichTextEditor id="doc-conditions-text" label="Texto" value={values.commercial_conditions?.text??null} disabled={!editable||busy||uncertain} onChange={text=>{if(mayEditBody())patch('commercial_conditions',{mode:'text',text:richTextEmpty(text)?null:text});}}/>}<div className="document-grid"><DocumentPaymentHeader kind={kind} values={values} options={paymentOptions} disabled={!editable||busy||uncertain} accountName={record?.payment_account_name??null} onChange={change=>{for(const [key,value] of Object.entries(change))patch(key as keyof DocumentInput,value as never);}} onConfigure={financeRole&&['admin','consulta','financeiro','vendas'].includes(financeRole)?()=>{if(isLocked())return;guard.confirmLeave(()=>navigate('/formas-pagamento-empresa'));}:undefined}/>{kind==='sales_orders'&&<button type="button" className="text-button document-auto-finance-open" onClick={()=>setAutoFinanceOpen(true)}>Lançamento automático de contas a receber</button>}{kind!=='sales_proposals'&&(writable||values.category_id)&&<DocumentCategoryPicker controller={controller} kind={kind} id="doc-category" selected={category} disabled={!editable||busy||uncertain} onSelect={row=>{if(!mayEditBody())return;setCategory(row);patch('category_id',row?.id??null);}}/>}{conditionsInstallments&&<div className="form-field document-wide"><label htmlFor="doc-payment">Condição de pagamento</label><textarea id="doc-payment" rows={2} maxLength={4000} value={values.payment_terms||''} onChange={event=>patch('payment_terms',event.target.value)}/><small>{kind==='sales_proposals'?PROPOSAL_CONDITION_HELP:CONDITION_HELP}</small>{editable&&<div className="document-condition"><label htmlFor="doc-condition" className="sr-only">Condição para gerar parcelas</label><input id="doc-condition" maxLength={200} placeholder="Ex: 30 60 90" value={condition} onChange={event=>setCondition(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();generateInstallments();}}}/><button type="button" className="secondary-button" onClick={generateInstallments}>Gerar parcelas</button></div>}</div>}<div className="form-field document-wide"><label htmlFor="doc-delivery">Entrega / prazo</label><textarea id="doc-delivery" rows={2} maxLength={2000} value={values.delivery_terms||''} onChange={event=>patch('delivery_terms',event.target.value)}/></div></div>
        {conditionsInstallments&&<><p className="real-help">Parcelas registram a condição comercial; viram contas a pagar ou a receber só em Lançar contas{kind==='sales_orders'?' (ou no lançamento automático das Preferências)':''}. Não geram boletos.</p>{(values.installments||[]).map((row,index)=><div className="document-installment" key={index}><span>Parcela {index+1}</span><label>Dias<input id={`doc-installment-days-${index}`} inputMode="numeric" maxLength={4} value={daysFrom(dayBase,row.due_date)} onChange={event=>{const due=dueFromDays(dayBase,event.target.value);if(due)patch('installments',values.installments!.map((p,i)=>i===index?{...p,due_date:due}:p));}}/></label><label>Vencimento<input id={`doc-installment-date-${index}`} type="date" required value={row.due_date} {...invalidProps(`doc-installment-date-${index}`)} onChange={event=>patch('installments',values.installments!.map((p,i)=>i===index?{...p,due_date:event.target.value}:p))}/></label><label>Valor (R$)<input id={`doc-installment-amount-${index}`} type="text" inputMode="decimal" required value={documentDecimalDisplay(row.amount)} {...invalidProps(`doc-installment-amount-${index}`)} onChange={event=>patch('installments',values.installments!.map((p,i)=>i===index?{...p,amount:documentDecimalInput(event.target.value)}:p))}/></label>{paymentOptions?.methods.length||row.payment_method_id?<InstallmentMethod index={index} row={row} kind={kind} options={paymentOptions} names={record?.payment_method_names} disabled={!editable||busy||uncertain} onChange={next=>patch('installments',values.installments!.map((p,i)=>i===index?next:p))}/>:<label>Forma prevista<input maxLength={100} value={row.method||''} onChange={event=>patch('installments',values.installments!.map((p,i)=>i===index?{...p,method:event.target.value}:p))}/></label>}{kind!=='sales_proposals'&&editable&&<button type="button" className="text-button" title="Ver detalhes" onClick={()=>{paymentSource.prefetch();setDetailsIndex(index);}}>Ver detalhes</button>}<label className="document-wide" htmlFor={`doc-installment-note-${index}`}>Observação da parcela<textarea id={`doc-installment-note-${index}`} maxLength={2000} rows={2} value={row.note??''} onChange={event=>patch('installments',values.installments!.map((p,i)=>i===index?{...p,note:event.target.value||null}:p))}/></label><div className="document-wide"><CommercialReferenceFields id={`doc-installment-reference-${index}`} label={`Forma de pagamento da parcela ${index+1}`} value={row.payment_reference??null} disabled={!editable||busy||uncertain} onChange={value=>patch('installments',values.installments!.map((p,i)=>i===index?{...p,payment_reference:value}:p))}/></div>{editable&&<button type="button" className="secondary-button" onClick={()=>patch('installments',values.installments!.filter((_,i)=>i!==index))}>Remover</button>}</div>)}{editable&&<button className="text-button" type="button" disabled={(values.installments?.length||0)>=120} onClick={()=>patch('installments',[...(values.installments||[]),{due_date:values.date,amount:'',method:null,note:null,payment_reference:null,payment_method_id:null,...(kind==='sales_proposals'?{}:{details:null})}])}>Adicionar outra parcela</button>}</>}
      </fieldset>{kind==='purchase_orders'&&commercialFields}<DocumentOptionalSection mode={prefs.showAdditional} label="dados adicionais" filled={Boolean((record?values.notes:values.notes&&values.notes!==initial.notes)||values.internal_notes)}><fieldset disabled={!(editable||notesOnly)||busy||uncertain} className="document-section"><legend>{kind==='sales_orders'||kind==='purchase_orders'?'Dados adicionais':'Observações'}</legend><div className="document-grid">{([['notes','Observações','Esta informação será impressa na venda, na fatura e transferida para as observações da nota'],['internal_notes','Observações internas','Esta informação é de uso interno, portanto não será impressa']] as const).map(([key,label,help])=><div className="form-field" key={key}><label htmlFor={`doc-${key}`}>{key==='notes'&&kind==='service_orders'?serviceItemLabel(prefs.labels,'servico_observacoes'):label}</label><textarea id={`doc-${key}`} rows={3} maxLength={4000} value={values[key]||''} onChange={event=>patchNotes(key,event.target.value)}/><small>{help}</small></div>)}</div></fieldset></DocumentOptionalSection>
    </form>
    {/* Origin tab "Assinatura" of the proposta: the user's own Saudação and Departamento, read when the tab is opened. */}
    {kind==='sales_proposals'&&<section className="document-section"><button type="button" className="text-button document-signature-open" aria-expanded={signatureOpen} onClick={()=>setSignatureOpen(value=>!value)}>Assinatura</button>
      {signatureOpen&&<DocumentSignature controller={controller} writable={writable} onLoaded={setUserSignature}/>}</section>}
    {occurrencesOpen&&record&&<DocumentOccurrences controller={controller} kind={kind} documentId={record.id} writable={writable} label={`${FORM_TITLES[kind]} ${record.number}`}
      targets={status=>!writable?[]:permittedTargets(kind,status,model&&situationRow?runnableTargets(model,kind,status,situationTargets(model,kind,rowAt(model,kind,situationRow,status)),financeRole??''):(TRANSITIONS[kind][status]||[]).filter(target=>!(effects.active||reservationActive)||effectTransitionAllowed(kind,status,target,effects.finance)).filter(target=>!(record.template&&target==='approved')),access?.permissions)}
      reasonNeeded={(from,to)=>reasonRequired(kind,from,to,model)} onClose={changed=>{setOccurrencesOpen(false);if(changed)void refreshForJournal();}}
      situationLabel={key=>situationName(model,kind,key)} transitionNote={(from,to)=>model?transitionNote(transitionActions(model,kind,from,to)):null}/>}
    {contactEdit&&values.contact_id&&<div className="document-contact-edit" role="dialog" aria-modal="true" aria-label="Editar contato"><ContactEditor controller={controller} entity="contacts" record={{id:values.contact_id,entity:'contacts',name:contact?.name??''} as unknown as CatalogRecord} writable onClose={()=>setContactEdit(false)}
      onSaved={saved=>{setContactEdit(false);setContact({id:saved.id,name:saved.name});const state=(saved as {state?:unknown}).state;setContactState(typeof state==='string'?state:null);
        // 279: with the stock posted the fornecedor and its retrato stay (the guards refuse a refreshed snapshot); only the cadastro changes.
        if(record&&saved.id===record.contact_id&&mayEditBody()&&!live.current.stockEditable){setRefreshContact(true);setContactStatus('Contato atualizado. Salve o documento para levar os dados novos do contato.');}else setContactStatus('Contato atualizado no cadastro.');}}/></div>}
    {attention&&<Modal title="Atenção" onClose={()=>setAttention('')} actions={<button type="button" className="primary-button" onClick={()=>setAttention('')}>OK</button>}><p>Não foi possível salvar o pedido de compra. Verifique os campos destacados.</p><p className="real-help">{attention}</p></Modal>}
    {contactSearch&&<DocumentContactSearch controller={controller} label={contactLabel} initialQuery="" onClose={()=>setContactSearch(false)} onSelect={row=>{if(!mayEditBody())return;setContactStatus('');setContact({id:row.id,name:row.name});setContactState(row.state);patch('contact_id',row.id);setContactSearch(false);}}/>}
    {detailsIndex!==null&&values.installments?.[detailsIndex]&&<InstallmentDetailsDialog kind={kind} index={detailsIndex} row={values.installments[detailsIndex]} baseDate={dayBase} options={paymentOptions} names={record?.payment_method_names} accountNames={record?.payment_account_names}
      onClose={()=>setDetailsIndex(null)} onApply={row=>{const index=detailsIndex;setDetailsIndex(null);if(mayEditBody())patch('installments',live.current.values.installments!.map((p,i)=>i===index?row:p));}}/>}
    {autoFinanceOpen&&<DocumentAutoFinance controller={controller} onClose={()=>setAutoFinanceOpen(false)}/>}
    {itemKit&&record&&<DocumentKitComponents controller={controller} documentId={record.id} itemId={itemKit} blocked={dirty||busy||uncertain||Boolean(nextStatus||reason)?'Salve ou descarte as alterações do pedido antes de editar os componentes do item.':null} onClose={()=>setItemKit(null)} onSaved={reloadAfterStock}/>}
    {lotItem!==null&&values.items[lotItem]?.product_id&&<DocumentItemLots controller={controller} kind={kind} warehouseId={values.warehouse_id||null} editable={editable&&!stockEditable} places={quantityPlaces(settings)}
      item={{index:lotItem,product_id:values.items[lotItem]!.product_id!,description:values.items[lotItem]!.description,quantity:values.items[lotItem]!.quantity,lots:values.items[lotItem]!.lots??[]}}
      onApply={lots=>{const index=lotItem;setLotItem(null);changeItem(index,{lots:lots.length?lots:null});}} onClose={()=>setLotItem(null)}/>}
    {itemLots&&record&&<SourceLotsPanel controller={controller} source="document" sourceId={record.id} productId={itemLots.productId} description={itemLots.description} onClose={()=>setItemLots(null)}/>}
    {itemStock&&<DocumentItemStock controller={controller} kind={kind} item={itemStock} warehouseId={values.warehouse_id||null} onClose={()=>setItemStock(null)}/>}
    {history&&<DocumentHistory controller={controller} kind={kind} contactId={values.contact_id||null} request={history} onClose={()=>setHistory(null)}/>}
    {quickContact&&<DocumentQuickContact controller={controller} kind={kind} initial={quickContact} onCreated={quickContactCreated} onClose={wasUncertain=>closeQuickContact(wasUncertain?'O resultado do cadastro rápido não foi confirmado. Pesquise o contato pelo nome ou CPF/CNPJ antes de cadastrá-lo de novo.':'')} onState={state=>{if(quickOpen.current)setQuickState(state);}}/>}
    <div className="document-preview-actions"><button type="button" className="secondary-button" disabled={!record||busy||uncertain||dirty||childDraft||Boolean(conversionReview)} onClick={()=>{if(mayAct(true)){setPrintTechnician(false);setPrintOpen(true);}}}>Visualizar impressão</button>{kind==='service_orders'&&<button type="button" className="secondary-button" disabled={!record||busy||uncertain||dirty||childDraft||Boolean(conversionReview)} title="Impressão da OS para o técnico, com as opções de Preferências › Serviços (ocultar valores e dados do cliente)." onClick={()=>{if(mayAct(true)){setPrintTechnician(true);setPrintOpen(true);}}}>Imprimir para técnico</button>}<p>{!record?'Salve o documento para visualizar a impressão.':dirty?'Salve as alterações para visualizar a versão atual.':'Documento comercial sem validade fiscal. A prévia usa a versão salva.'}</p></div>
    {/* 202610200288 Origin: "Imprimir campos customizados na ordem de serviço?" before the print of an OS with campos customizados. */}
    {printOpen&&record&&(kind==='service_orders'&&hasCustomValues(record.custom_fields)&&printAsk===null&&customFields!=='error'?(Array.isArray(customFields)&&customWanted?<CustomFieldsPrintQuestion onCancel={()=>setPrintOpen(false)} onPrint={include=>setPrintAsk({include})}/>:null)
      :<DocumentPrintPreview record={record} controller={controller} options={{...(printTechnician?{...printOptions,technician:true}:printOptions),...(printAsk?.include&&Array.isArray(customFields)?{customFields}:{})}} onClose={()=>{setPrintOpen(false);setPrintAsk(null);}}/>)}
    {record&&osStockDenied&&financeRole&&['admin','estoque'].includes(financeRole)&&<p className="real-help">Seu usuário não tem a permissão “Lançar estoque” das ordens de serviço (Sistema › Usuários › Permissões).</p>}
    <span id="document-finance-anchor" aria-hidden="true"/>{record&&financeEnabled&&<DocumentFinance controller={controller} record={record} writable={(financeRole==='admin'||financeRole==='financeiro')&&!osFinanceDenied} blocked={receiptBusy||receiptDraft||reservationBusy||reservationDraft||installmentDraft||dirty||documentBusy||uncertain||attachmentBusy||attachmentDraft||stockBusy||stockDraft||journalBusy||journalDraft||eventBusy||eventDraft||Boolean(nextStatus||reason)} canAct={()=>!pending.current&&!live.current.documentBusy&&!childConflict('finance')} onChanged={acceptFinanceDocument} onActive={setFinanceActive} onBusy={childCallbacks.finance.onBusy} onDraft={childCallbacks.finance.onDraft} onOpenTitle={openFinanceTitle}/>}
    {record&&prefs.openTitles&&(kind==='sales_orders'||kind==='purchase_orders')&&<FinanceContactOpenTitles key={`${record.contact_id}:${controller.getSnapshot().membership?.user_id||''}`} controller={controller} contactId={record.contact_id} kind={kind==='purchase_orders'?'payable':'receivable'}/>}
    {record&&reservationEnabled&&<SalesOrderReservations key={`${record.id}:${controller.getSnapshot().membership?.user_id||''}`} controller={controller} record={record} blocked={installmentDraft||dirty||documentBusy||uncertain||attachmentBusy||attachmentDraft||financeBusy||financeDraft||stockBusy||stockDraft||journalBusy||journalDraft||eventBusy||eventDraft||Boolean(nextStatus||reason||conversionReview)} canAct={()=>!pending.current&&!live.current.documentBusy&&!childConflict('reservation')} onChanged={reloadAfterReservation} onActive={setReservationObserved} onBusy={childCallbacks.reservation.onBusy} onDraft={childCallbacks.reservation.onDraft}/> }
    {record&&receiptEnabled&&<PurchaseReceipts controller={controller} record={record} blocked={reservationBusy||reservationDraft||installmentDraft||dirty||documentBusy||uncertain||attachmentBusy||attachmentDraft||financeBusy||financeDraft||stockBusy||stockDraft||journalBusy||journalDraft||eventBusy||eventDraft||Boolean(nextStatus||reason||conversionReview)} canAct={()=>!pending.current&&!live.current.documentBusy&&!childConflict('receipt')} onChanged={reloadAfterReceipt} onActive={setReceiptObserved} onMode={setReceiptModeObserved} onBusy={childCallbacks.receipt.onBusy} onDraft={childCallbacks.receipt.onDraft}/>}
    <span id="document-stock-anchor" aria-hidden="true"/>{record&&stockEnabled&&<DocumentStock controller={controller} record={record} launchDay={settings?.stock_launch_date?stockLaunchDay(settings.stock_launch_date,record,today()):undefined} blocked={receiptBusy||receiptDraft||reservationActive!==false&&reservationEnabled||reservationBusy||reservationDraft||installmentDraft||dirty||documentBusy||uncertain||attachmentBusy||attachmentDraft||financeBusy||financeDraft||journalBusy||journalDraft||eventBusy||eventDraft||Boolean(nextStatus||reason)} canAct={()=>!pending.current&&!live.current.documentBusy&&!childConflict('stock')&&(!receiptEnabled||receiptState.current.mode==='legacy_full')} onChanged={reloadAfterStock} onActive={setStockActive} onBusy={childCallbacks.stock.onBusy} onDraft={childCallbacks.stock.onDraft}/>}
    <section className="document-section"><div className="attachment-heading"><h3>Anexos do documento</h3>{record&&<button type="button" className="secondary-button" disabled={busy||uncertain||receiptDraft||reservationDraft||installmentDraft||financeDraft||stockDraft||journalDraft||eventDraft||Boolean(conversionReview)} aria-expanded={attachmentsOpen} onClick={()=>{if(isLocked()||children.current.receipt.draft||children.current.reservation.draft||children.current.installment.draft||children.current.finance.draft||children.current.stock.draft||children.current.journal.draft||children.current.event.draft||live.current.conversionReview)return;attachmentsOpen?guard.confirmLeave(()=>setAttachmentsOpen(false)):setAttachmentsOpen(true);}}>{attachmentsOpen?'Recolher anexos':'Ver / adicionar anexos'}</button>}</div>{!record?<p className="real-help">Salve o documento para incluir anexos.</p>:attachmentsOpen&&<DocumentAttachments controller={controller} kind={kind} documentId={record.id} writable={writable} blocked={receiptBusy||receiptDraft||reservationBusy||reservationDraft||installmentDraft||documentBusy||uncertain||financeBusy||financeDraft||stockBusy||stockDraft||journalBusy||journalDraft||eventBusy||eventDraft||Boolean(conversionReview)} canAct={()=>!pending.current&&!live.current.documentBusy&&!childConflict('attachment')} onDraft={childCallbacks.attachment.onDraft} onBusy={childCallbacks.attachment.onBusy}/>}</section>
    {record&&kind==='service_orders'&&<ServiceOrderJournal key={`${record.id}:${controller.getSnapshot().membership?.user_id||''}`} controller={controller} documentId={record.id} documentVersion={record.version} actorId={controller.getSnapshot().membership?.user_id} writable={writable} blocked={receiptBusy||receiptDraft||reservationBusy||reservationDraft||installmentDraft||dirty||documentBusy||uncertain||attachmentBusy||attachmentDraft||financeBusy||financeDraft||stockBusy||stockDraft||eventBusy||eventDraft||Boolean(nextStatus||reason)} onDraft={childCallbacks.journal.onDraft} onBusy={childCallbacks.journal.onBusy} onRefreshDocument={()=>void refreshForJournal()}/>}
    {record&&eventsEnabled&&<><div className="document-preview-actions"><button type="button" className="secondary-button" disabled={busy||uncertain||dirty||childDraft||Boolean(nextStatus||reason||conversionReview)} onClick={()=>void refreshForJournal()}>Atualizar OS salva</button><p>Use após descartar alterações locais para conferir mudanças feitas por outra pessoa. Os registros abaixo não alteram a OS.</p></div><ServiceOrderEvents key={`${record.id}:${controller.getSnapshot().membership?.user_id||''}`} controller={controller} document={{id:record.id,version:record.version}} blocked={receiptBusy||receiptDraft||reservationBusy||reservationDraft||installmentDraft||dirty||documentBusy||uncertain||financeBusy||financeDraft||stockBusy||stockDraft||attachmentBusy||attachmentDraft||journalBusy||journalDraft||Boolean(nextStatus||reason||conversionReview)} onBusy={childCallbacks.event.onBusy} onDraft={childCallbacks.event.onDraft}/></>}
    {record&&writable&&<section className="document-section"><h3>Andamento do documento</h3><p className="real-help">{model?transitionNote(nextActions):'Alterar a situação registra o andamento. Estoque, financeiro e emissão fiscal não são lançados por esta ação.'}</p>{nextBlocked&&<p className="real-notice" role="note">A transição para {situationName(model,kind,nextStatus)} lança ou estorna estoque ou contas, e seu perfil não faz esses lançamentos.</p>}{dirty&&<p className="real-notice">Salve as alterações do formulário antes de mudar a situação ou converter.</p>}{situationNote&&<p className="real-notice" role="note">{situationNote}</p>}<div className="document-grid"><div className="form-field"><label htmlFor="doc-next-status">Nova situação</label><select id="doc-next-status" value={nextStatus} disabled={busy||uncertain||dirty||childDraft||Boolean(conversionReview)} onChange={event=>{if(mayAct()&&!live.current.dirty&&!live.current.conversionReview){live.current.nextStatus=event.target.value;setNextStatus(event.target.value);}}}><option value="">Selecione uma transição</option>{transitions.map(status=><option key={status} value={status}>{situationName(model,kind,status)}</option>)}</select></div><div className="form-field"><label htmlFor="doc-reason">Motivo (obrigatório ao cancelar ou reabrir)</label><input id="doc-reason" maxLength={1000} value={reason} disabled={busy||uncertain||dirty||childDraft||Boolean(conversionReview)} onChange={event=>{if(mayAct()&&!live.current.dirty&&!live.current.conversionReview){live.current.reason=event.target.value;setReason(event.target.value);}}}/></div></div><div className="real-editor-actions"><button className="secondary-button" disabled={busy||uncertain||dirty||childDraft||Boolean(conversionReview)||!nextStatus||nextBlocked} onClick={changeStatus}>Alterar situação</button>{kind==='sales_proposals'&&!['completed','cancelled'].includes(record.status)&&!record.template&&<>{(['sales_orders','service_orders'] as const).map(target=><button key={target} className="primary-button" disabled={busy||uncertain||dirty||childDraft||Boolean(nextStatus||reason||conversionReview)} onClick={()=>reviewConversion(target)}>{target==='service_orders'?'Gerar ordem de serviço':'Gerar pedido de venda'}</button>)}</>}</div>{kind==='sales_orders'&&<DocumentSalesToService controller={controller} record={record} canWrite={Boolean(access?.write.includes('service_orders'))} blocked={busy||uncertain||dirty||childDraft||Boolean(nextStatus||reason||conversionReview)}
        onCreated={os=>{if(isLocked())return;guard.store.runConfirmed(()=>navigate(`/documentos-empresa?${new URLSearchParams({tipo:'service_orders',documento:os.id})}`));}}/>}{record.source_proposal_id&&<p className="real-help">Documento criado a partir de uma proposta aprovada. <button type="button" className="text-button" disabled={busy||uncertain} onClick={()=>{if(isLocked())return;guard.confirmLeave(()=>navigate(`/documentos-empresa?${new URLSearchParams({tipo:'sales_proposals',documento:record.source_proposal_id!})}`));}}>Abrir proposta de origem</button></p>}</section>}
  </section>;
}

export default function RealDocuments({controller,initialKind='sales_proposals'}:{controller:AccessController;initialKind?:DocumentKind}){
  const location=useLocation();const navigate=useNavigate();
  // The list keeps an uncertain status command in the shared guard; leaving it for Incluir asks first.
  const listGuard=useUnsavedChangesGuard();
  const [access,setAccess]=useState<DocumentAccess|null>(null);const [kind,setKind]=useState<DocumentKind>(initialKind);const [listPage,setListPage]=useState(1);const [order,setOrder]=useState<DocumentListOrder>('date_desc');
  const [filters,setFilters]=useState<DocumentListFilters>(EMPTY_LIST_FILTERS);const [filterError,setFilterError]=useState('');
  const [page,setPage]=useState<DocumentListPage|null>(null);const [record,setRecord]=useState<DocumentReadRecord|null>(null);const [editing,setEditing]=useState(false);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const [notice,setNotice]=useState('');const [reload,setReload]=useState(0);const [editorEpoch,setEditorEpoch]=useState(0);const detail=useRef<AbortController|null>(null);
  const [copyDraft,setCopyDraft]=useState<DocumentCopyDraft|null>(null);const [importDraftState,setImportDraft]=useState<ImportDraft|null>(null),[xmlRequest,setXmlRequest]=useState(0);const [numbering,setNumbering]=useState(false);const [printHeader,setPrintHeader]=useState(false);const [discountApproval,setDiscountApproval]=useState(false);const [checkout,setCheckout]=useState(false);const [reports,setReports]=useState<{report:ReportId|null}|null>(null);
  // 202610200104: the user's list settings are read before the first page, so "Tornar padrão" (or Origin's "Em aberto") applies at once.
  const [listView,setListView]=useState<ListView|null>(null),[viewReady,setViewReady]=useState<string|null>(null),[viewReload,setViewReload]=useState(0);
  const [detailLoading,setDetailLoading]=useState(false),[detailError,setDetailError]=useState(''),[detailReload,setDetailReload]=useState(0);
  // Preferências of the open kind, read once per kind and user; until then (or when unreadable) the defaults apply.
  const [documentPrefs,setDocumentPrefs]=useState<DocumentPreferences|null>(null);const prefsActor=controller.getSnapshot?.()?.membership?.user_id??null;
  // 202610200163 Gerenciador de transições of the open kind, read before the first page (the filter then uses exact situações).
  const [situations,setSituations]=useState<SituationModel|null>(null),[situationsReady,setSituationsReady]=useState<string|null>(null);
  useEffect(()=>{if(!access?.read.includes(kind))return;const request=new AbortController();setSituations(null);setSituationsReady(null);
    void Promise.resolve().then(()=>controller.documents(`/v1/documentos/${kind}/situacoes`,{signal:request.signal})).then(value=>{if(request.signal.aborted||(controller.getSnapshot?.()?.membership?.user_id??null)!==prefsActor)return;setSituations(readSituations(value,kind));setSituationsReady(kind);})
      .catch(()=>{if(!request.signal.aborted){setSituations(null);setSituationsReady(kind);}});
    return()=>request.abort();},[controller,access,kind,prefsActor]);
  const situationQuery={situations:managed(situations,kind)};
  useEffect(()=>{if(!access?.read.includes(kind))return;const request=new AbortController();setDocumentPrefs(null);
    void Promise.resolve().then(()=>readDocumentPreferences(controller,kind,request.signal)).then(value=>{if(!request.signal.aborted&&(controller.getSnapshot?.()?.membership?.user_id??null)===prefsActor)setDocumentPrefs(value);})
      .catch(()=>{if(!request.signal.aborted)setDocumentPrefs(defaultDocumentPreferences(kind));});
    return()=>request.abort();},[controller,access,kind,prefsActor]);
  const routeDocument=location.pathname==='/documentos-empresa'?new URLSearchParams(location.search).get('documento'):null;
  const hasRouteDocument=location.pathname==='/documentos-empresa'&&(new URLSearchParams(location.search).has('documento')||new URLSearchParams(location.search).has('acao')||new URLSearchParams(location.search).has('proposta'));
  const validRouteDocument=Boolean(routeDocument&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(routeDocument));
  useEffect(()=>{const request=new AbortController();void controller.documents('/v1/documentos',{signal:request.signal}).then(value=>{if(!request.signal.aborted){const permissions=value as DocumentAccess;setAccess(permissions);setKind(permissions.read.includes(initialKind)?initialKind:permissions.read[0]||'sales_proposals');if(!permissions.read.length)setLoading(false);}}).catch(failure=>{if(!aborted(failure)){setError(errorText(failure));setLoading(false);}});return()=>{request.abort();detail.current?.abort();};},[controller]);
  useEffect(()=>{
    if(!access?.read.includes(kind))return;
    if(!LIST_VIEW_KINDS.includes(kind)){setListView(null);if(viewReload===0&&!access.mirror_available)setFilters(previous=>JSON.stringify(previous)===JSON.stringify(EMPTY_LIST_FILTERS)?defaultListFilters(kind,today()):previous);setViewReady(kind);return;}
    const request=new AbortController(),actor=controller.getSnapshot?.()?.membership?.user_id;setViewReady(null);
    void Promise.resolve().then(()=>controller.documents(`/v1/documentos/${kind}/preferencias-listagem`,{signal:request.signal})).then(value=>{
      if(request.signal.aborted||controller.getSnapshot?.()?.membership?.user_id!==actor)return;
      const view=readListView(value,kind);setListView(view);
      // Applied only while the screen still has no filter of its own.
      if(viewReload===0&&!access.mirror_available)setFilters(previous=>JSON.stringify(previous)===JSON.stringify(EMPTY_LIST_FILTERS)?{...EMPTY_LIST_FILTERS,statuses:[...view.default_statuses]}:previous);
      setViewReady(kind);
    }).catch(()=>{if(!request.signal.aborted){setListView(null);setViewReady(kind);}});
    return()=>request.abort();
  },[controller,access,kind,viewReload]);
  // EST-029 Origin pedidos de compra: every record of the period in one scroll; the next page is appended to the rows already shown
  // (the same reload); a reload or a new filter starts again from the first page.
  const appendKey=useRef('');
  useEffect(()=>{if(!access?.read.includes(kind)||viewReady!==kind||situationsReady!==kind)return;
    const key=`${reload}`,append=kind==='purchase_orders'&&listPage>1&&appendKey.current===key;if(kind==='purchase_orders'&&listPage>1&&!append){setListPage(1);return;}
    let params:URLSearchParams;try{params=documentListQuery(kind,filters,{page:listPage,order,...situationQuery});}catch(failure){setFilterError((failure as Error).message);setLoading(false);return;}const request=new AbortController();setLoading(true);if(!append)setPage(null);setError('');void controller.documents(`/v1/documentos/${kind}?${params}`,{signal:request.signal}).then(value=>{if(!request.signal.aborted){const result=readDocumentListPage(value,kind,listPage,order);
    // The filtered set shrank (for example after a batch change): go to its last page instead of an empty one.
    const last=pageCount(result.total_count);if(listPage>last){if(append){setLoading(false);return;}setListPage(last);return;}
    appendKey.current=key;
    setPage(previous=>append&&previous&&previous.page===listPage-1&&previous.order===order?{...result,items:[...previous.items,...result.items.filter(row=>!previous.items.some(item=>item.id===row.id))]}:result);setLoading(false);}}).catch(failure=>{if(!request.signal.aborted&&!aborted(failure)){setError(errorText(failure));setLoading(false);}});return()=>request.abort();},[controller,access,kind,filters,listPage,order,reload,viewReady,situationsReady]);
  useEffect(()=>{
    if(location.pathname!=='/documentos-empresa')return;
    detail.current?.abort();detail.current=null;setCopyDraft(null);setImportDraft(null);setRecord(null);setEditing(false);setDetailError('');setDetailLoading(false);setNumbering(false);setPrintHeader(false);setDiscountApproval(false);setCheckout(false);setReports(null);
    const params=new URLSearchParams(location.search),id=params.get('documento');
    // A local Incluir on a stable list does not change the URL, so this effect
    // does not discard its draft. URL navigation, including Back, owns this view.
    // Origin routes as query parameters (#add, #clone/<id>): acao=incluir opens a new document, acao=clonar&origem=<id> the reviewed copy.
    // 202610200238 (wave E): proposta=<id> (Origin #idOrigem/<idProposta>) is the same as acao=proposta&origem=<id>.
    const action=params.get('acao')??(params.has('proposta')?'proposta':null);
    if(action&&!params.has('documento')){
      if(!access)return;
      // Preferências "Próximo número" (acao=numeracao): administrador only, as the server enforces.
      // Origin "Relatórios de vendas" / "Relatórios de serviço" (acao=relatorios[&relatorio=<id>]), for readers of the kind.
      if(action==='relatorios'){const report=params.get('relatorio');if(kind!=='sales_orders'&&kind!=='service_orders'||!access.read.includes(kind)){setDetailError('Seu perfil não permite consultar estes relatórios.');return;}
        if(report!==null&&(!isReportId(report)||reportKind(report)!==kind)){setDetailError('Relatório não encontrado. Volte à listagem.');return;}setReports({report});return;}
      // 202610200239 Preferências › Vendas "Situação para aprovação de descontos" (acao=aprovacao-descontos), for readers of pedidos de venda.
      // 202610200291 Vendas › Logística "Checkout de pedidos" (acao=checkout), for who writes pedidos de venda.
      if(action==='checkout'){if(kind!=='sales_orders'||!access.write.includes('sales_orders')){setDetailError('Seu perfil não faz o checkout de pedidos.');return;}setCheckout(true);return;}
      if(action==='aprovacao-descontos'){if(kind!=='sales_orders'||!access.read.includes('sales_orders')){setDetailError('Seu perfil não permite consultar esta configuração.');return;}setDiscountApproval(true);return;}
      // 202610200270 Preferências "Exibir tipo de cabeçalho: Personalizado" (acao=cabecalho): readers of the kind; the administrador edits it.
      if(action==='cabecalho'){if(!access.read.includes(kind)){setDetailError('Seu perfil não consulta os documentos deste tipo.');return;}setPrintHeader(true);return;}
      if(action==='numeracao'){if(!access.write.includes(kind)||controller.getSnapshot?.()?.membership?.role!=='admin'){setDetailError('Somente o administrador ajusta o próximo número.');return;}setNumbering(true);return;}
      // Origin #addXml: acao=xml opens "Importar › Pedido XML" over the list (pedidos de venda e de compra).
      if(action==='xml'&&(kind==='sales_orders'||kind==='purchase_orders')){if(!access.write.includes(kind)){setDetailError('Seu perfil não permite incluir este documento.');return;}setXmlRequest(value=>value+1);params.delete('acao');navigate(`${location.pathname}?${params}`,{replace:true});return;}
      // 202610200196 Origin "Gerar venda" / "Gerar ordem de serviço" (vendas.php#idOrigem/<id>): acao=proposta&origem=<proposta> opens the
      // new pedido/OS prefilled with the proposta; nothing is saved until Salvar, which also concludes the proposta.
      if(action==='proposta'){
        if((kind!=='sales_orders'&&kind!=='service_orders')||!access.write.includes(kind)||!access.write.includes('sales_proposals')){setDetailError('Seu perfil não permite gerar este documento a partir da proposta.');return;}
        const origin=(params.get('origem')??params.get('proposta')??'').toLowerCase();
        if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(origin)){setDetailError('O endereço contém um identificador de documento inválido. Volte à listagem.');return;}
        const request=new AbortController(),target=kind;detail.current=request;setDetailLoading(true);
        void controller.documents(`/v1/documentos/${target}/a-partir-da-proposta/${origin}`,{signal:request.signal}).then(value=>{if(request.signal.aborted||detail.current!==request)return;setImportDraft(proposalDraft(value,target,origin));setRecord(null);setEditing(true);setEditorEpoch(n=>n+1);})
          .catch(failure=>{if(!request.signal.aborted&&!aborted(failure))setDetailError(failure instanceof AccessError&&failure.code==='MODULE_OWNED_BY_ORIGIN'?DOCUMENT_MIRROR_READ_ONLY:failure instanceof AccessError&&failure.status===409?'Esta proposta já gerou uma venda ou ordem de serviço. Abra a proposta para conferir o documento gerado.':failure instanceof AccessError&&failure.status===400?'Esta proposta não pode gerar documentos (cancelada, concluída ou modelo).':errorText(failure));})
          .finally(()=>{if(detail.current===request){detail.current=null;if(!request.signal.aborted)setDetailLoading(false);}});
        return()=>{request.abort();if(detail.current===request)detail.current=null;};
      }
      // 202610200197 Sacola de vendas (listagem de produtos › Gerar pedido de venda): a new pedido with the products of the bag.
      if(action==='sacola'){
        if(kind!=='sales_orders'||!access.write.includes('sales_orders')){setDetailError('Seu perfil não permite incluir pedidos de venda.');return;}
        const request=new AbortController();detail.current=request;setDetailLoading(true);
        void controller.documents(SALES_BAG_PATH,{signal:request.signal}).then(value=>{if(request.signal.aborted||detail.current!==request)return;const bag=readSalesBag(value);
          if(!bag.items.some(item=>item.active)){setDetailError('A sacola de vendas está vazia. Adicione produtos pela sacola da listagem de produtos.');return;}
          setImportDraft(salesBagDraft(bag,today()));setRecord(null);setEditing(true);setEditorEpoch(n=>n+1);})
          .catch(failure=>{if(!request.signal.aborted&&!aborted(failure))setDetailError(errorText(failure));})
          .finally(()=>{if(detail.current===request){detail.current=null;if(!request.signal.aborted)setDetailLoading(false);}});
        return()=>{request.abort();if(detail.current===request)detail.current=null;};
      }
      // Origin #add-fisica ("Registrar vendas físicas"): the venda de balcão is the Frente de caixa (202610200204-206).
      if(action==='venda-fisica'&&kind==='sales_orders'){navigate('/frente-caixa-empresa',{replace:true});return;}
      if(!['incluir','clonar'].includes(action)){setDetailError('Esta ação ainda não está disponível no FAGOO. Volte à listagem.');return;}
      if(!access.write.includes(kind)){setDetailError('Seu perfil não permite incluir este documento.');return;}
      if(action==='incluir'){setRecord(null);setEditing(true);setEditorEpoch(value=>value+1);return;}
      const origin=params.get('origem')??'';
      if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(origin)){setDetailError('O endereço contém um identificador de documento inválido. Volte à listagem.');return;}
      void cloneRow({id:origin.toLowerCase()});return;
    }
    if(!params.has('documento'))return;
    if(!id||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)){setDetailError('O endereço contém um identificador de documento inválido. Volte à listagem.');return;}
    if(!access)return;
    if(!access.read.includes(kind)){setDetailError('Seu perfil não permite consultar este tipo de documento.');return;}
    const request=new AbortController();detail.current=request;setDetailLoading(true);
    void controller.documents(`/v1/documentos/${kind}/${id}`,{signal:request.signal}).then(value=>{if(!request.signal.aborted&&detail.current===request){const document=(value as {document:DocumentReadRecord}).document;if(document.id.toLowerCase()!==id.toLowerCase()||document.kind!==kind)throw new AccessError(502);setRecord(document);setEditing(true);}})
      .catch(failure=>{if(!request.signal.aborted&&!aborted(failure))setDetailError(errorText(failure));})
      .finally(()=>{if(detail.current===request){detail.current=null;if(!request.signal.aborted)setDetailLoading(false);}});
    return()=>{request.abort();if(detail.current===request)detail.current=null;};
  },[controller,access,kind,location.pathname,location.search,detailReload]);
  const close=()=>{if(copyDraft){setCopyDraft(null);setEditorEpoch(value=>value+1);return;}setImportDraft(null);detail.current?.abort();detail.current=null;setEditing(false);setRecord(null);setDetailError('');setDetailLoading(false);if(location.pathname==='/documentos-empresa'){const params=new URLSearchParams(location.search);if(params.has('documento')||params.has('acao')||params.has('origem')||params.has('proposta')){params.delete('documento');params.delete('acao');params.delete('origem');params.delete('proposta');params.delete('relatorio');navigate(`${location.pathname}?${params}`,{replace:true});}}};const reset=()=>{setListPage(1);close();};
  const clearFilters=()=>{setFilters(EMPTY_LIST_FILTERS);setFilterError('');setOrder('date_desc');};
  const selectKind=(value:DocumentKind)=>{if(location.pathname==='/documentos-empresa'){const params=new URLSearchParams(location.search);params.set('tipo',value);params.delete('documento');navigate(`${location.pathname}?${params}`);}else{setKind(value);clearFilters();setNotice('');reset();}};
  const converted=(result:ConversionEnvelope)=>{
    const target=conversionDocument(result);
    if(location.pathname==='/documentos-empresa'){const params=new URLSearchParams(location.search);params.set('tipo',target.kind);params.set('documento',target.id);navigate(`${location.pathname}?${params}`);}
    else{setKind(target.kind);clearFilters();setListPage(1);setRecord(target);setNotice(`Proposta concluída. ${target.kind==='service_orders'?'Ordem de serviço':'Pedido de venda'} ${target.number} ${target.kind==='service_orders'?'criada':'criado'}.`);setReload(n=>n+1);}
  };
  const copied=(saved:DocumentRecord)=>{
    setCopyDraft(null);setRecord(saved);setEditorEpoch(value=>value+1);setNotice('Novo documento criado.');setReload(value=>value+1);
    if(location.pathname==='/documentos-empresa'){const params=new URLSearchParams(location.search);params.set('tipo',saved.kind);params.set('documento',saved.id);navigate(`${location.pathname}?${params}`);}
  };
  const applyFilters=(next:DocumentListFilters)=>{try{documentListQuery(kind,next,{page:1,order,...situationQuery});}catch(failure){setFilterError((failure as Error).message);return false;}setFilters(next);setFilterError('');setNotice('');reset();return true;};
  const open=async(id:string)=>{if(location.pathname==='/documentos-empresa'){const params=new URLSearchParams(location.search);params.set('documento',id);navigate(`${location.pathname}?${params}`);return;}detail.current?.abort();const request=new AbortController();detail.current=request;setError('');try{const response=await controller.documents(`/v1/documentos/${kind}/${id}`,{signal:request.signal}) as {document:DocumentReadRecord};if(!request.signal.aborted&&detail.current===request){setRecord(response.document);setEditing(true);}}catch(failure){if(!request.signal.aborted&&!aborted(failure))setError(errorText(failure));}finally{if(detail.current===request)detail.current=null;}};
  const writable=Boolean(access?.write.includes(kind));
  // Origin opens a record by clicking its row; Ctrl/Cmd or middle click opens the same deep link in a new tab.
  const deepLinked=location.pathname==='/documentos-empresa';
  const openRow=(id:string,event:{ctrlKey?:boolean;metaKey?:boolean;button?:number})=>{if(deepLinked&&opensInNewTab(event)){const params=new URLSearchParams(location.search);params.set('tipo',kind);params.set('documento',id);window.open(`${location.pathname}?${params}`,'_blank','noopener');return;}void open(id);};
  const changeOrder=(next:DocumentListOrder)=>{setOrder(next);setListPage(1);};
  // ⋮ Clonar: the same reviewed copy preview as "Duplicar como novo", opened from the list; nothing is saved until Salvar.
  // mode "model" (Criar modelo) and "model_copy" (Clonar modelo) open the reviewed copy as a modelo; "copy" is a plain proposta/documento.
  const cloneRow=async(row:Pick<DocumentListRow,'id'>,mode:'copy'|'model'|'model_copy'='copy')=>{
    if(!writable)return;detail.current?.abort();const request=new AbortController();detail.current=request;setError('');setNotice('');
    try{
      const response=await controller.documents(`/v1/documentos/${kind}/${row.id}`,{signal:request.signal}) as DocumentEnvelope;if(request.signal.aborted||detail.current!==request)return;
      const source=response?.document;if(!source||source.id!==row.id||source.kind!==kind)throw new AccessError(502);if(isMirrorRecord(source)){setError(DOCUMENT_MIRROR_READ_ONLY);return;}
      const preview=readCopyPreview(await controller.documentCopy(`/v1/duplicacao-documentos/${kind}/${source.id}/preview`,{signal:request.signal}),source);if(request.signal.aborted||detail.current!==request)return;
      const asModel=kind==='sales_proposals'&&mode!=='copy';
      const reviewed=asModel?{...preview,data:{...preview.data,template:true,template_name:mode==='model_copy'?source.template_name??null:null}}:preview;
      setRecord(source);setCopyDraft({preview:reviewed,contact:{id:source.contact_id,name:source.contact_snapshot.name}});setEditing(true);setEditorEpoch(value=>value+1);
    }catch(failure){if(!request.signal.aborted&&!aborted(failure))setError(failure instanceof CopyPreviewChanged?failure.message:errorText(failure));}
    finally{if(detail.current===request)detail.current=null;}
  };
  const create=()=>listGuard.confirmLeave(()=>{close();setRecord(null);setEditing(true);setEditorEpoch(value=>value+1);setNotice('');});
  const importedDraft=(draft:ImportDraft)=>{if(draft.kind!==kind||!access?.write.includes(kind))return;detail.current?.abort();setCopyDraft(null);setRecord(null);setImportDraft(draft);setEditing(true);setEditorEpoch(value=>value+1);setNotice('');};
  const openCreated=(target:DocumentKind,id:string,message:string)=>{if(location.pathname==='/documentos-empresa'){const params=new URLSearchParams(location.search);params.set('tipo',target);params.set('documento',id);navigate(`${location.pathname}?${params}`);return;}setKind(target);clearFilters();setListPage(1);close();setNotice(message);setReload(n=>n+1);};
  return <>
    <header className="real-heading"><div><h1>{LIST_TITLES[kind]}</h1></div>{!writable&&<span className="real-mode">Somente consulta</span>}{writable&&!editing&&!hasRouteDocument&&<button type="button" className="primary-button documents-primary" title={PRIMARY[kind].title} onClick={event=>{if(deepLinked&&opensInNewTab(event)){window.open(`${location.pathname}?${new URLSearchParams({tipo:kind,acao:'incluir'})}`,'_blank','noopener');return;}create();}} onAuxClick={event=>{if(deepLinked&&event.button===1)window.open(`${location.pathname}?${new URLSearchParams({tipo:kind,acao:'incluir'})}`,'_blank','noopener');}}><Icon name="plus" size={12}/>{PRIMARY[kind].label}</button>}</header>
    {notice&&<p className="real-success" role="status">{notice}</p>}
    {error&&<p className="real-alert" role="alert">{error}<button className="text-button" onClick={()=>access?setReload(n=>n+1):controller.retry()}>Tentar novamente</button></p>}
    {editing&&record&&isMirrorRecord(record)?<DocumentMirrorView record={record} onClose={close}/>:editing?<Editor key={`${kind}:${record?.id||'new'}:${record?.version||0}:${editorEpoch}:${copyDraft?'copy':importDraftState?'import':'document'}`} importDraft={copyDraft||record?null:importDraftState} controller={controller} kind={kind} record={copyDraft||record&&isMirrorRecord(record)?null:record} copyDraft={copyDraft} onCopyPrepared={draft=>{setCopyDraft(draft);setNotice('');setEditorEpoch(value=>value+1);}} onCopied={copied} writable={writable} preferences={documentPrefs??undefined} situations={situations} access={access} onClose={close} onSaved={(saved,message)=>{setImportDraft(null);setRecord(saved);setEditorEpoch(value=>value+1);setNotice(message??'Documento atualizado.');setReload(n=>n+1);}} onConverted={converted}/>:numbering?<DocumentNumbering controller={controller} kind={kind} onClose={close}/>:printHeader?<DocumentPrintHeader controller={controller} kind={kind} onClose={close}/>:discountApproval?<DocumentDiscountApproval controller={controller} onClose={close}/>:checkout?<SalesCheckout controller={controller} onClose={close}/>:reports&&(kind==='sales_orders'||kind==='service_orders')?<DocumentReports controller={controller} kind={kind} report={reports.report} today={today()} onClose={close} onOpen={id=>{const params=new URLSearchParams(location.search);if(id)params.set('relatorio',id);else params.delete('relatorio');navigate(`${location.pathname}?${params}`);}}/>:hasRouteDocument?<section className="real-editor" aria-label="Consulta do documento">
      {(detailLoading||!access)&&<p role="status">Carregando documento…</p>}{detailError&&<p className="real-alert" role="alert">{detailError}</p>}
      <div className="real-editor-actions">{detailError&&validRouteDocument&&<button type="button" className="primary-button" disabled={detailLoading} onClick={()=>setDetailReload(value=>value+1)}>Tentar consultar documento novamente</button>}<button type="button" className="secondary-button" onClick={close}>Voltar à listagem</button></div>
    </section>:
      <DocumentList key={kind} controller={controller} kind={kind} access={access} writable={writable} today={today()} page={page} loading={loading} filters={filters} order={order} listPage={listPage} filterError={filterError}
        onApply={applyFilters} onPage={setListPage} onOrder={changeOrder} onReload={()=>setReload(n=>n+1)} onKind={selectKind} onOpen={openRow} onClone={(row,mode)=>void cloneRow(row,mode)} onConverted={openCreated} onNavigate={path=>navigate(path)} onCreate={writable?create:undefined} listView={listView} onListView={view=>{if(view)setListView(view);else setViewReload(value=>value+1);}} preferences={documentPrefs} situations={situations} onImported={writable?importedDraft:undefined} xmlRequest={xmlRequest} onXmlRequestHandled={()=>setXmlRequest(0)}/>}
  </>;
}
