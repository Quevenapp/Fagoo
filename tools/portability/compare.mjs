import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const name = /^[A-Za-z_][A-Za-z0-9_$-]{0,127}$/;
const objectName = /^[A-Za-z_][A-Za-z0-9_$-]{0,127}\.[A-Za-z_][A-Za-z0-9_$-]{0,127}$/;
const rowCount = /^(0|[1-9][0-9]*)$/;
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
  return value;
}
export function validateMapping(mapping = { version: 1 }) {
  if (!mapping || mapping.version !== 1 || Object.keys(mapping).some(key => !['version', 'schemas', 'objects', 'roles', 'buckets'].includes(key))) throw new Error('MAPPING_INVALID');
  const result = { version: 1 };
  for (const section of ['schemas', 'objects', 'roles', 'buckets']) {
    const entries = Object.entries(mapping[section] || {});
    if (Array.isArray(mapping[section]) || entries.length > 2000) throw new Error('MAPPING_INVALID');
    const pattern = section === 'objects' ? objectName : name;
    if (entries.some(([from, to]) => !pattern.test(from) || typeof to !== 'string' || !pattern.test(to)) || new Set(entries.map(([, to]) => to)).size !== entries.length) throw new Error('MAPPING_NOT_ONE_TO_ONE');
    result[section] = Object.fromEntries(entries);
  }
  return result;
}

function validateManifest(manifest) {
  if (!manifest || manifest.formatVersion !== 1 || manifest.consistency?.readOnly !== true || manifest.consistency?.isolation !== 'repeatable read' || manifest.consistency?.exactCounts !== true || !manifest.database?.serverVersionNum || !manifest.storage || typeof manifest.storage.available !== 'boolean') throw new Error('MANIFEST_INVALID');
  for (const field of ['schemas', 'extensions', 'roles', 'memberships', 'relations', 'routines', 'sequences', 'types', 'counts']) if (!Array.isArray(manifest[field])) throw new Error('MANIFEST_INVALID');
  if (typeof manifest.migrationVersions?.available !== 'boolean' || !Array.isArray(manifest.migrationVersions.versions)) throw new Error('MANIFEST_INVALID');
  const seen = new Set();
  for (const count of manifest.counts) {
    const key = `${count.schema}.${count.name}`;
    if (typeof count.rows !== 'string' || !rowCount.test(count.rows) || seen.has(key)) throw new Error('MANIFEST_COUNT_INVALID');
    seen.add(key);
  }
  for (const relation of manifest.relations) if (['r', 'p'].includes(relation.relationKind) && !seen.has(`${relation.schema}.${relation.name}`)) throw new Error('MANIFEST_COUNT_MISSING');
}

export function compareInventories(source, target, inputMapping) {
  validateManifest(source); validateManifest(target);
  const mapping = validateMapping(inputMapping);
  const mapped = (section, value) => Object.hasOwn(mapping[section], value) ? mapping[section][value] : value;
  const mappedSchema = value => mapped('schemas', value);
  const mappedRole = value => mapped('roles', value);
  const qualified = (schema, object) => Object.hasOwn(mapping.objects, `${schema}.${object}`) ? mapping.objects[`${schema}.${object}`] : `${mappedSchema(schema)}.${object}`;
  const normalizeType = value => typeof value !== 'string' ? value : value.replace(/("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$-]*)\./g, (match, token) => {
    const from = token.startsWith('"') ? token.slice(1, -1).replaceAll('""', '"') : token;
    if (!Object.hasOwn(mapping.schemas, from)) return match;
    const to = mapping.schemas[from]; return `${token.startsWith('"') || to.includes('-') ? `"${to}"` : to}.`;
  });
  const mapRecord = (value, section) => {
    const result = structuredClone(value);
    if (section === 'extensions') result.schema = mappedSchema(result.schema);
    else if (result.schema && result.name) {
      const destination = qualified(result.schema, result.name); const dot = destination.indexOf('.');
      result.schema = destination.slice(0, dot); result.name = destination.slice(dot + 1);
    } else if (section === 'schemas') result.name = mappedSchema(result.name);
    else if (section === 'roles') result.name = mappedRole(result.name);
    if (result.owner) result.owner = mappedRole(result.owner);
    if (result.arguments) result.arguments = normalizeType(result.arguments);
    if (result.returns) result.returns = normalizeType(result.returns);
    if (result.type) result.type = normalizeType(result.type);
    if (result.baseType) result.baseType = normalizeType(result.baseType);
    if (result.parent) result.parent = result.parent.map(parent => mapRecord(parent, 'relations'));
    if (result.columns) result.columns = result.columns.map(column => ({ ...column, type: normalizeType(column.type) }));
    return result;
  };
  const blockers = [], observations = [];
  const block = (code, details = {}) => blockers.push({ code, ...details });
  if (Math.floor(Number(source.database.serverVersionNum) / 10000) !== Math.floor(Number(target.database.serverVersionNum) / 10000)) block('POSTGRES_MAJOR_VERSION_DIFFERS');
  for (const field of ['encoding', 'collation', 'ctype']) if (source.database[field] !== target.database[field]) block('DATABASE_SETTING_DIFFERS', { field });
  const keyFor = (item, section) => ['schemas', 'roles', 'extensions'].includes(section) ? item.name : `${item.schema}.${item.name}${section === 'routines' ? `(${item.arguments})` : ''}`;
  for (const section of ['schemas', 'roles', 'extensions', 'relations', 'routines', 'sequences', 'types']) {
    const expected = source[section].map(item => mapRecord(item, section));
    const destination = new Map(target[section].map(item => [keyFor(item, section), item]));
    const expectedKeys = expected.map(item => keyFor(item, section));
    if (new Set(expectedKeys).size !== expectedKeys.length || destination.size !== target[section].length) throw new Error('MAPPING_OR_MANIFEST_COLLISION');
    for (const item of expected) {
      const object = keyFor(item, section), actual = destination.get(object);
      if (!actual) { block('DESTINATION_OBJECT_MISSING', { section, object }); continue; }
      const fields = new Set([...Object.keys(item), ...Object.keys(actual)]);
      const differences = [...fields].filter(field => canonical(item[field]) !== canonical(actual[field]));
      if (differences.length) block('OBJECT_METADATA_DIFFERS', { section, object, fields: differences });
      if (section === 'relations' && item.relationKind === 'f') block('FOREIGN_TABLE_REQUIRES_REVIEW', { object });
      if (section === 'sequences' && (item.lastValue === null || actual.lastValue === null)) block('SEQUENCE_STATE_NOT_PROVEN', { object });
    }
    for (const object of destination.keys()) if (!expectedKeys.includes(object)) observations.push({ code: 'ADDITIONAL_DESTINATION_OBJECT', section, object });
  }
  const sourceMemberships = source.memberships.map(item => ({ ...item, role: mappedRole(item.role), member: mappedRole(item.member) })).map(canonical).sort();
  if (canonical(sourceMemberships) !== canonical(target.memberships.map(canonical).sort())) block('ROLE_MEMBERSHIPS_DIFFER');
  const targetCounts = new Map(target.counts.map(item => [`${item.schema}.${item.name}`, item.rows]));
  const mappedCounts = new Set();
  for (const item of source.counts) {
    const object = qualified(item.schema, item.name);
    if (mappedCounts.has(object)) throw new Error('MAPPING_OR_MANIFEST_COLLISION');
    mappedCounts.add(object);
    const actual = targetCounts.get(object);
    if (actual === undefined) block('DESTINATION_DATA_MISSING', { object, sourceRows: item.rows });
    else if (actual !== item.rows) block('ROW_COUNT_DIFFERS', { object, sourceRows: item.rows, destinationRows: actual });
  }
  const expectedStorage = structuredClone(source.storage);
  if (expectedStorage.buckets) expectedStorage.buckets = expectedStorage.buckets.map(bucket => ({ ...bucket, id: mapped('buckets', bucket.id), name: mapped('buckets', bucket.name) })).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const actualStorage = structuredClone(target.storage);
  if (actualStorage.buckets) actualStorage.buckets.sort((a, b) => a.id.localeCompare(b.id, 'en'));
  if (canonical(expectedStorage) !== canonical(actualStorage)) block('STORAGE_METADATA_DIFFERS');
  if (canonical(source.migrationVersions) !== canonical(target.migrationVersions)) block('MIGRATION_VERSIONS_DIFFER');
  return {
    formatVersion: 1, generatedAt: new Date().toISOString(), status: blockers.length ? 'blocked' : 'inventory-compatible', ready: false,
    summary: { blockers: blockers.length, sourceRelations: source.relations.length, targetRelations: target.relations.length, comparedCounts: source.counts.length },
    blockers, observations,
    requiredEvidence: [
      'Private consistent database backup and successful isolated restore, including real Auth/Storage schemas and extension compatibility.',
      'Preserved actor UUIDs, memberships, authentication/MFA migration and deliberate session invalidation.',
      'Object-byte manifest, hashes, private access and storage metadata reconciliation; separate A1 keyring/context validation.',
      'Inventory/finance balances, partial settlements, reservations, reversals, document links and fiscal numbering reconciled.',
      'Permissions, idempotency, fiscal uncertain attempts and no-replay business regression tests.',
      'Freeze/delta/cutover and rollback rehearsal, plus capacity and external backup restore checks.',
    ],
    note: 'Matching inventory is necessary evidence only. Counts and catalog hashes cannot establish data equality or operational readiness. Namespace mapping only changes comparison identifiers, never database contents or encrypted artifacts.',
  };
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--source', '--target', '--map', '--output'].includes(key) || !args[index + 1] || options[key]) throw new Error('COMPARE_USAGE_INVALID');
    options[key] = args[index + 1];
  }
  if (!options['--source'] || !options['--target'] || !options['--output']) throw new Error('COMPARE_USAGE_INVALID');
  const read = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('PRIVATE_INPUT_UNREADABLE'); } };
  const [source, target, mapping] = await Promise.all([read(options['--source']), read(options['--target']), options['--map'] ? read(options['--map']) : undefined]);
  const report = compareInventories(source, target, mapping);
  await writeFile(options['--output'], `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then(report => { console.log(`Comparação: ${report.status}; impedimentos: ${report.summary.blockers}. Pronto para migração: não comprovado.`); process.exitCode = report.blockers.length ? 2 : 0; }).catch(error => { console.error(error.code === 'EEXIST' ? 'OUTPUT_ALREADY_EXISTS' : /^[A-Z_]+$/.test(error.message) ? error.message : 'COMPARE_FAILED'); process.exitCode = 1; });
