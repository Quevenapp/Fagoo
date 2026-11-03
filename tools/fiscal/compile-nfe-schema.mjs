#!/usr/bin/env node
// Compiles the official NF-e 4.00 XSDs of PL 010f v1.04 (packages/fiscal-schema/schemas/pl010f-v1.04, hash-pinned by its manifest) into the
// compact grammar read by packages/fiscal-xml/src/schema-check.mjs, so that the Worker can check a generated NF-e / NFC-e against the
// official layout without Python, network or the XSD files at run time. The output is deterministic and checked in; a test regenerates
// it and compares the bytes. Only the types reachable from the NFe element are kept; the xmldsig types stay outside (the generated XML is
// not signed, and the signature has its own verifier).
//   node tools/fiscal/compile-nfe-schema.mjs          writes packages/fiscal-xml/src/nfe-schema-pl010f.mjs
//   node tools/fiscal/compile-nfe-schema.mjs --check  exits 1 when the checked-in file differs
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// The XML parser is the pinned dependency of packages/fiscal-xml (the same one the Worker bundles).
const { DOMParser } = createRequire(new URL('../../packages/fiscal-xml/package.json', import.meta.url))('@xmldom/xmldom');

const ROOT = new URL('../../', import.meta.url);
const SCHEMA_DIR = new URL('packages/fiscal-schema/schemas/pl010f-v1.04/', ROOT);
export const GRAMMAR_FILE = new URL('packages/fiscal-xml/src/nfe-schema-pl010f.mjs', ROOT);
const XS = 'http://www.w3.org/2001/XMLSchema';
const FILES = ['nfe_v4.00.xsd', 'leiauteNFe_v4.00.xsd', 'tiposBasico_v4.00.xsd', 'DFeTiposBasicos_v1.00.xsd'];
const BUILTIN = { string: '#string', ID: '#ID', gYearMonth: '#gYearMonth', base64Binary: '#base64Binary', anyURI: '#anyURI', token: '#string' };

const kids = node => Array.from(node.childNodes ?? []).filter(n => n.nodeType === 1 && n.namespaceURI === XS && n.localName !== 'annotation');
const local = qname => qname.includes(':') ? qname.slice(qname.indexOf(':') + 1) : qname;
const prefix = qname => qname.includes(':') ? qname.slice(0, qname.indexOf(':')) : '';
const occurs = node => [Number(node.getAttribute('minOccurs') || '1'), node.getAttribute('maxOccurs') === 'unbounded' ? -1 : Number(node.getAttribute('maxOccurs') || '1')];

/** Reads the four files, after checking their size and SHA-256 against the pinned manifest. */
export async function readSchemas() {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', SCHEMA_DIR), 'utf8'));
  if (manifest.id !== 'pl010f-v1.04') throw new Error('SCHEMA_MANIFEST_UNEXPECTED');
  const docs = [];
  for (const name of FILES) {
    const bytes = await readFile(new URL(name, SCHEMA_DIR)), entry = manifest.files.find(f => f.name === name);
    // A checkout may change the line endings (core.autocrlf); the manifest pins the published bytes, so the file must match them as
    // is, with LF or with CRLF line endings, and nothing else.
    const lf = bytes.toString('utf8').replace(/\r\n/g, '\n');
    const published = [bytes, Buffer.from(lf, 'utf8'), Buffer.from(lf.replace(/\n/g, '\r\n'), 'utf8')]
      .find(candidate => entry && entry.bytes === candidate.length && entry.sha256 === createHash('sha256').update(candidate).digest('hex'));
    if (!published) throw new Error(`SCHEMA_FILE_TAMPERED:${name}`);
    docs.push(new DOMParser().parseFromString(published.toString('utf8').replace(/^\uFEFF/, ''), 'application/xml').documentElement);
  }
  return { manifest, docs };
}

export function compile(docs) {
  const named = new Map();
  for (const schema of docs) for (const node of kids(schema)) if (['complexType', 'simpleType', 'element'].includes(node.localName) && node.getAttribute('name')) {
    const key = `${node.localName === 'element' ? 'element' : 'type'}:${node.getAttribute('name')}`;
    if (named.has(key)) throw new Error(`SCHEMA_DUPLICATE:${key}`);
    named.set(key, node);
  }
  const types = {}, pending = [];
  let anonymous = 0;
  const typeRef = qname => {
    const name = local(qname), p = prefix(qname);
    if (p === 'xs' || (p === '' && BUILTIN[name] && !named.has(`type:${name}`))) { if (!BUILTIN[name]) throw new Error(`SCHEMA_BUILTIN_UNSUPPORTED:${qname}`); return BUILTIN[name]; }
    if (p === 'ds') return '#sig';
    if (!named.has(`type:${name}`)) throw new Error(`SCHEMA_TYPE_MISSING:${qname}`);
    if (!(name in types)) { types[name] = null; pending.push([name, named.get(`type:${name}`)]); }
    return name;
  };
  const inline = node => { const name = `@${++anonymous}`; types[name] = null; pending.push([name, node]); return name; };
  const particle = node => {
    const [min, max] = occurs(node);
    if (node.localName === 'element') {
      if (node.getAttribute('ref')) { if (prefix(node.getAttribute('ref')) !== 'ds') throw new Error('SCHEMA_REF_UNSUPPORTED'); return ['e', local(node.getAttribute('ref')), '#sig', min, max]; }
      const typed = node.getAttribute('type'), body = kids(node).find(n => ['complexType', 'simpleType'].includes(n.localName));
      return ['e', node.getAttribute('name'), typed ? typeRef(typed) : body ? inline(body) : '#string', min, max];
    }
    if (node.localName === 'sequence' || node.localName === 'choice') return [node.localName === 'sequence' ? 's' : 'h', min, max, kids(node).map(particle)];
    throw new Error(`SCHEMA_PARTICLE_UNSUPPORTED:${node.localName}`);
  };
  const facets = (restriction, out) => {
    for (const f of kids(restriction)) {
      const value = f.getAttribute('value');
      if (f.localName === 'pattern') (out.p ??= []).push(value);
      else if (f.localName === 'enumeration') (out.e ??= []).push(value);
      else if (f.localName === 'length') out.l = Number(value);
      else if (f.localName === 'minLength') out.mn = Number(value);
      else if (f.localName === 'maxLength') out.mx = Number(value);
      else if (f.localName === 'minInclusive') out.mi = value;
      else if (f.localName === 'whiteSpace') { if (value !== 'preserve') throw new Error('SCHEMA_WHITESPACE_UNSUPPORTED'); }
      else if (f.localName !== 'simpleType') throw new Error(`SCHEMA_FACET_UNSUPPORTED:${f.localName}`);
    }
    return out;
  };
  const define = node => {
    if (node.localName === 'simpleType') {
      const restriction = kids(node).find(n => n.localName === 'restriction');
      if (!restriction || kids(node).length !== 1) throw new Error('SCHEMA_SIMPLE_UNSUPPORTED');
      return facets(restriction, { b: typeRef(restriction.getAttribute('base')) });
    }
    if (node.localName !== 'complexType') throw new Error('SCHEMA_TYPE_UNSUPPORTED');
    const out = { c: null, a: [] };
    for (const child of kids(node)) {
      if (child.localName === 'attribute') {
        const typed = child.getAttribute('type'), body = kids(child).find(n => n.localName === 'simpleType');
        out.a.push([child.getAttribute('name'), typed ? typeRef(typed) : body ? inline(body) : '#string', child.getAttribute('use') === 'required' ? 1 : 0]);
      } else if (child.localName === 'sequence' || child.localName === 'choice') { if (out.c) throw new Error('SCHEMA_CONTENT_DUPLICATE'); out.c = particle(child); }
      else if (child.localName !== 'unique') throw new Error(`SCHEMA_COMPLEX_UNSUPPORTED:${child.localName}`);
    }
    return out;
  };
  // Inline element bodies may carry xs:unique; it is not kept (the generator writes nItem in sequence and the checker confirms it).
  const root = named.get('element:NFe');
  if (!root) throw new Error('SCHEMA_ROOT_MISSING');
  const elements = { NFe: typeRef(root.getAttribute('type')) };
  while (pending.length) { const [name, node] = pending.shift(); types[name] = define(node); }
  return { profile: 'pl010f-v1.04', namespace: 'http://www.portalfiscal.inf.br/nfe', elements, types };
}

export async function render() {
  const { manifest, docs } = await readSchemas();
  const grammar = compile(docs);
  const digest = createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex');
  return `// Generated by tools/fiscal/compile-nfe-schema.mjs from the official XSDs of ${manifest.id} (${manifest.publisher}, ${manifest.published_on};\n`
    + `// files ${FILES.join(', ')}; manifest files digest ${digest}). Do not edit: change the generator and run it again.\n`
    + `// Particles: ['e', name, type, min, max] element, ['s'|'h', min, max, items] sequence | choice; max -1 is unbounded. Types: {c, a} complex\n`
    + `// (content and attributes [name, type, required]) or {b, p, e, l, mn, mx, mi} simple (base and facets). '#sig' is the xmldsig Signature.\n`
    + `const grammar = ${JSON.stringify(grammar)};\nexport default grammar;\n`;
}

if (import.meta.url === new URL(process.argv[1], 'file:').href || process.argv[1]?.endsWith('compile-nfe-schema.mjs')) {
  const text = await render();
  if (process.argv.includes('--check')) {
    const current = (await readFile(GRAMMAR_FILE, 'utf8').catch(() => '')).replace(/\r\n/g, '\n');
    if (current !== text) { console.error('nfe-schema-pl010f.mjs is out of date: run node tools/fiscal/compile-nfe-schema.mjs'); process.exit(1); }
  } else await writeFile(GRAMMAR_FILE, text);
}
