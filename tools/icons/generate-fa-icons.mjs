// Generates apps/erp/src/components/fa-icons.ts from Font Awesome Free 6.5.2 packages (CC BY 4.0 icons).
// Reads icon files as TEXT (never executes package code).
// 1. In an empty folder: npm pack @fortawesome/free-solid-svg-icons@6.5.2 @fortawesome/free-regular-svg-icons@6.5.2 @fortawesome/free-brands-svg-icons@6.5.2
// 2. Extract each tarball into x-solid/, x-regular/, x-brands/ (tar -xzf <tgz> -C x-<style>)
// 3. node tools/icons/generate-fa-icons.mjs <that folder> apps/erp/src/components/fa-icons.ts
import fs from 'node:fs';
import path from 'node:path';

const [, , root, outFile] = process.argv;
if (!root || !outFile) throw new Error('usage: node gen-fa.mjs <pkgRoot> <outFile>');

// Origin class name (v5 or v6) -> [style, FA file base name]
const WANT = {
  // shell
  'bars': ['solid', 'faBars'], 'magnifying-glass': ['solid', 'faMagnifyingGlass'], 'search': ['solid', 'faMagnifyingGlass'],
  'bell': ['solid', 'faBell'], 'question-circle': ['solid', 'faCircleQuestion'], 'circle-question': ['solid', 'faCircleQuestion'],
  'gear': ['solid', 'faGear'], 'cog': ['solid', 'faGear'], 'wand-magic-sparkles': ['solid', 'faWandMagicSparkles'],
  'grip': ['solid', 'faGrip'], 'table-cells-large': ['solid', 'faTableCellsLarge'], 'th-large': ['solid', 'faTableCellsLarge'], 'th-list': ['solid', 'faTableList'],
  'house': ['solid', 'faHouse'], 'home': ['solid', 'faHouse'], 'bookmark': ['solid', 'faBookmark'], 'star': ['solid', 'faStar'],
  'building': ['solid', 'faBuilding'], 'user': ['solid', 'faUser'], 'user-tie': ['solid', 'faUserTie'], 'users': ['solid', 'faUsers'],
  'arrow-right-from-bracket': ['solid', 'faArrowRightFromBracket'], 'sign-out-alt': ['solid', 'faArrowRightFromBracket'],
  'clock-rotate-left': ['solid', 'faClockRotateLeft'], 'moon': ['solid', 'faMoon'], 'sun': ['solid', 'faSun'],
  'gift': ['solid', 'faGift'], 'comments': ['solid', 'faComments'], 'headset': ['solid', 'faHeadset'], 'lightbulb': ['solid', 'faLightbulb'],
  'keyboard': ['solid', 'faKeyboard'],
  // toolbar & list
  'plus': ['solid', 'faPlus'], 'minus': ['solid', 'faMinus'], 'filter': ['solid', 'faFilter'],
  'calendar': ['solid', 'faCalendar'], 'calendar-alt': ['solid', 'faCalendarDays'], 'calendar-days': ['solid', 'faCalendarDays'],
  'calendar-times': ['solid', 'faCalendarXmark'], 'calendar-xmark': ['solid', 'faCalendarXmark'],
  'print': ['solid', 'faPrint'], 'trash-alt': ['solid', 'faTrashCan'], 'trash-can': ['solid', 'faTrashCan'],
  'ellipsis-v': ['solid', 'faEllipsisVertical'], 'ellipsis-vertical': ['solid', 'faEllipsisVertical'], 'ellipsis-h': ['solid', 'faEllipsis'],
  'redo-alt': ['solid', 'faRotateRight'], 'rotate-right': ['solid', 'faRotateRight'], 'arrows-rotate': ['solid', 'faArrowsRotate'],
  'list': ['solid', 'faList'], 'table-list': ['solid', 'faTableList'], 'toggle-on': ['solid', 'faToggleOn'], 'sliders': ['solid', 'faSliders'],
  'times': ['solid', 'faXmark'], 'xmark': ['solid', 'faXmark'], 'times-circle': ['solid', 'faCircleXmark'], 'circle-xmark': ['solid', 'faCircleXmark'],
  'check': ['solid', 'faCheck'], 'check-circle': ['solid', 'faCircleCheck'], 'circle-check': ['solid', 'faCircleCheck'],
  'check-square': ['solid', 'faSquareCheck'], 'square-check': ['solid', 'faSquareCheck'],
  'minus-square': ['solid', 'faSquareMinus'], 'square-minus': ['solid', 'faSquareMinus'], 'plus-square': ['solid', 'faSquarePlus'], 'square-plus': ['solid', 'faSquarePlus'],
  'chevron-right': ['solid', 'faChevronRight'], 'chevron-left': ['solid', 'faChevronLeft'], 'chevron-down': ['solid', 'faChevronDown'], 'chevron-up': ['solid', 'faChevronUp'],
  'angle-down': ['solid', 'faAngleDown'], 'angle-left': ['solid', 'faAngleLeft'], 'angle-right': ['solid', 'faAngleRight'],
  'caret-down': ['solid', 'faCaretDown'], 'caret-up': ['solid', 'faCaretUp'], 'sort': ['solid', 'faSort'],
  'arrow-right': ['solid', 'faArrowRight'], 'arrow-left': ['solid', 'faArrowLeft'], 'arrow-up': ['solid', 'faArrowUp'], 'arrow-down': ['solid', 'faArrowDown'],
  'arrow-up-right-from-square': ['solid', 'faArrowUpRightFromSquare'], 'external-link-alt': ['solid', 'faUpRightFromSquare'], 'up-right-from-square': ['solid', 'faUpRightFromSquare'],
  'info-circle': ['solid', 'faCircleInfo'], 'circle-info': ['solid', 'faCircleInfo'], 'info': ['solid', 'faInfo'],
  'exclamation-triangle': ['solid', 'faTriangleExclamation'], 'triangle-exclamation': ['solid', 'faTriangleExclamation'],
  'exclamation-circle': ['solid', 'faCircleExclamation'], 'circle-exclamation': ['solid', 'faCircleExclamation'], 'exclamation': ['solid', 'faExclamation'],
  'clock': ['solid', 'faClock'], 'comment': ['solid', 'faComment'], 'circle': ['solid', 'faCircle'], 'eye': ['solid', 'faEye'], 'eye-slash': ['solid', 'faEyeSlash'],
  'pencil-alt': ['solid', 'faPencil'], 'pencil': ['solid', 'faPencil'], 'edit': ['solid', 'faPenToSquare'], 'pen-to-square': ['solid', 'faPenToSquare'],
  'copy': ['solid', 'faCopy'], 'clone': ['solid', 'faClone'], 'image': ['solid', 'faImage'], 'paperclip': ['solid', 'faPaperclip'], 'link': ['solid', 'faLink'],
  // actions
  'file-invoice-dollar': ['solid', 'faFileInvoiceDollar'], 'file-invoice': ['solid', 'faFileInvoice'], 'adjust': ['solid', 'faCircleHalfStroke'], 'circle-half-stroke': ['solid', 'faCircleHalfStroke'],
  'shopping-cart': ['solid', 'faCartShopping'], 'cart-shopping': ['solid', 'faCartShopping'], 'shopping-bag': ['solid', 'faBagShopping'], 'bag-shopping': ['solid', 'faBagShopping'],
  'truck': ['solid', 'faTruck'], 'paper-plane': ['solid', 'faPaperPlane'], 'envelope': ['solid', 'faEnvelope'], 'barcode': ['solid', 'faBarcode'], 'qrcode': ['solid', 'faQrcode'],
  'file-pdf': ['solid', 'faFilePdf'], 'file-code': ['solid', 'faFileCode'], 'file-excel': ['solid', 'faFileExcel'], 'file-alt': ['solid', 'faFileLines'], 'file-lines': ['solid', 'faFileLines'],
  'file-signature': ['solid', 'faFileSignature'], 'file-import': ['solid', 'faFileImport'], 'file-export': ['solid', 'faFileExport'], 'file-upload': ['solid', 'faFileArrowUp'],
  'sticky-note': ['solid', 'faNoteSticky'], 'note-sticky': ['solid', 'faNoteSticky'], 'cube': ['solid', 'faCube'], 'cubes': ['solid', 'faCubes'], 'box': ['solid', 'faBox'], 'boxes-stacked': ['solid', 'faBoxesStacked'],
  'dollar-sign': ['solid', 'faDollarSign'], 'sitemap': ['solid', 'faSitemap'], 'upload': ['solid', 'faUpload'], 'download': ['solid', 'faDownload'],
  'random': ['solid', 'faShuffle'], 'shuffle': ['solid', 'faShuffle'], 'retweet': ['solid', 'faRetweet'], 'dolly': ['solid', 'faDolly'],
  'comments-dollar': ['solid', 'faCommentsDollar'], 'university': ['solid', 'faBuildingColumns'], 'building-columns': ['solid', 'faBuildingColumns'],
  'arrow-alt-circle-right': ['solid', 'faCircleRight'], 'circle-right': ['solid', 'faCircleRight'], 'arrow-alt-circle-left': ['solid', 'faCircleLeft'], 'circle-left': ['solid', 'faCircleLeft'],
  'hand-holding-usd': ['solid', 'faHandHoldingDollar'], 'hand-holding-dollar': ['solid', 'faHandHoldingDollar'], 'level-down-alt': ['solid', 'faTurnDown'], 'turn-down': ['solid', 'faTurnDown'],
  'briefcase': ['solid', 'faBriefcase'], 'shield-alt': ['solid', 'faShieldHalved'], 'shield-halved': ['solid', 'faShieldHalved'], 'ban': ['solid', 'faBan'],
  'credit-card': ['solid', 'faCreditCard'], 'money-bill-alt': ['solid', 'faMoneyBill1'], 'money-bill-1': ['solid', 'faMoneyBill1'], 'cash-register': ['solid', 'faCashRegister'],
  'tag': ['solid', 'faTag'], 'tags': ['solid', 'faTags'], 'arrows-spin': ['solid', 'faArrowsSpin'], 'warehouse': ['solid', 'faWarehouse'], 'store': ['solid', 'faStore'],
  'chart-line': ['solid', 'faChartLine'], 'chart-pie': ['solid', 'faChartPie'], 'chart-column': ['solid', 'faChartColumn'], 'trophy': ['solid', 'faTrophy'], 'bullseye': ['solid', 'faBullseye'],
  'screwdriver-wrench': ['solid', 'faScrewdriverWrench'], 'tools': ['solid', 'faScrewdriverWrench'], 'wrench': ['solid', 'faWrench'], 'users-gear': ['solid', 'faUsersGear'],
  'floppy-disk': ['solid', 'faFloppyDisk'], 'save': ['solid', 'faFloppyDisk'], 'clipboard-list': ['solid', 'faClipboardList'], 'clipboard-check': ['solid', 'faClipboardCheck'],
  'receipt': ['solid', 'faReceipt'], 'calculator': ['solid', 'faCalculator'], 'percent': ['solid', 'faPercent'], 'certificate': ['solid', 'faCertificate'], 'key': ['solid', 'faKey'],
  'cloud-arrow-down': ['solid', 'faCloudArrowDown'], 'database': ['solid', 'faDatabase'], 'plug': ['solid', 'faPlug'], 'truck-fast': ['solid', 'faTruckFast'], 'scale-balanced': ['solid', 'faScaleBalanced'],
  'arrow-up-from-bracket': ['solid', 'faArrowUpFromBracket'], 'right-left': ['solid', 'faRightLeft'], 'layer-group': ['solid', 'faLayerGroup'], 'list-check': ['solid', 'faListCheck'],
  'desktop': ['solid', 'faDesktop'], 'address-book': ['solid', 'faAddressBook'], 'table-columns': ['solid', 'faTableColumns'], 'grip-vertical': ['solid', 'faGripVertical'],
  'square': ['solid', 'faSquare'], 'list-ul': ['solid', 'faListUl'], 'rotate-left': ['solid', 'faRotateLeft'], 'arrow-down-short-wide': ['solid', 'faArrowDownShortWide'],
  'money-bill-transfer': ['solid', 'faMoneyBillTransfer'], 'hand-holding': ['solid', 'faHandHolding'], 'box-open': ['solid', 'faBoxOpen'], 'truck-ramp-box': ['solid', 'faTruckRampBox'],
  'circle-plus': ['solid', 'faCirclePlus'], 'circle-minus': ['solid', 'faCircleMinus'], 'clipboard': ['solid', 'faClipboard'],
  'whatsapp': ['brands', 'faWhatsapp'],
};

const out = {};
const missing = [];
for (const [name, [style, file]] of Object.entries(WANT)) {
  const p = path.join(root, `x-${style}`, 'package', `${file}.js`);
  if (!fs.existsSync(p)) { missing.push(`${name} (${style}/${file})`); continue; }
  const src = fs.readFileSync(p, 'utf8');
  const w = /var width = (\d+);/.exec(src)?.[1];
  const h = /var height = (\d+);/.exec(src)?.[1];
  const d = /var svgPathData = '([^']+)';/.exec(src)?.[1];
  if (!w || !h || !d || !/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/.test(d)) { missing.push(`${name} (unparsed)`); continue; }
  out[name] = [Number(w), Number(h), d, file];
}
if (missing.length) { console.error('MISSING:\n' + missing.join('\n')); process.exitCode = 1; }

const header = `/*! Font Awesome Free 6.5.2 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free (Icons: CC BY 4.0) Copyright 2024 Fonticons, Inc. */
// Generated from Font Awesome Free 6.5.2 (solid and brands) for the Origin-like interface (19/10/2026).
// Path data is unmodified; names include the Font Awesome 5 aliases used by the Origin interface. Do not edit by hand.
`;
const files = new Map();
for (const [w, h, d, file] of Object.values(out)) files.set(file, [w, h, d]);
const body = `export type FaIconDefinition = readonly [width: number, height: number, path: string];\n\nconst D = {\n${[...files].map(([f, [w, h, d]]) => `  ${f}: [${w}, ${h}, ${JSON.stringify(d)}] as FaIconDefinition,`).join('\n')}\n};\n\nexport const FA_ICONS: Readonly<Record<string, FaIconDefinition>> = {\n${Object.entries(out).map(([k, [, , , file]]) => `  ${JSON.stringify(k)}: D.${file},`).join('\n')}\n};\n`;
fs.writeFileSync(outFile, header + '\n' + body, 'utf8');
console.log(`wrote ${Object.keys(out).length} icons to ${outFile}`);
