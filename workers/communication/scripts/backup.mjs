#!/usr/bin/env node
import { readFile, writeFile, mkdir, appendFile, rm } from "node:fs/promises";
import { parse } from "jsonc-parser";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {createHash} from 'node:crypto';
const config = process.argv[2] || "wrangler.production.local.json",
  dir =
    process.argv[3] ||
    "backup-" + new Date().toISOString().replace(/[:.]/g, "-");
const storageMode = process.argv.includes('--local') ? '--local' : '--remote';
await mkdir(dir, { recursive: true, mode: 0o700 });
await mkdir(path.join(dir, "media"), { recursive: true, mode: 0o700 });
await rm(path.join(dir, "manifest.json"), { force: true });
const cfg = parse(await readFile(config, "utf8")),
  wrangler = fileURLToPath(
    new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
  );
function run(args, capture = false) {
  const r = spawnSync(
    process.execPath,
    [wrangler, ...args, "--config", config],
    {
      encoding: "utf8",
      stdio: capture ? "pipe" : "inherit",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (r.status !== 0)
    throw Error("Backup interrompido; não considere esta cópia completa.");
  return r.stdout;
}
function query(sql) {
  return JSON.parse(
    run(["d1", "execute", "DB", storageMode, "--command", sql, "--json"], true),
  ).flatMap((r) => r.results || []);
}
const schema = query(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'chunks%' ORDER BY name",
);
console.log(
  "Exportando tabelas operacionais; o índice FTS será reconstruído na restauração.",
);
run(
  [
    "d1",
    "export",
    "DB",
    storageMode,
    "--output",
    path.join(dir, "database.sql"),
    "--skip-confirmation",
    "--table",
    ...schema.map((r) => r.name),
  ],
  true,
);
await appendFile(
  path.join(dir, "database.sql"),
  "\nCREATE VIRTUAL TABLE chunks USING fts5(profile_id UNINDEXED,document_id UNINDEXED,text,url UNINDEXED);\n",
);
const sqlValue = (v) =>
  v === null
    ? "NULL"
    : typeof v === "number"
      ? String(v)
      : "'" + String(v).replaceAll("'", "''") + "'";
let cursor = 0;
for (;;) {
  const rows = query(
    "SELECT rowid,profile_id,document_id,text,url FROM chunks WHERE rowid>" +
      cursor +
      " ORDER BY rowid LIMIT 500",
  );
  if (!rows.length) break;
  await appendFile(
    path.join(dir, "database.sql"),
    rows
      .map(
        (row) =>
          "INSERT INTO chunks(rowid,profile_id,document_id,text,url) VALUES(" +
          [row.rowid, row.profile_id, row.document_id, row.text, row.url]
            .map(sqlValue)
            .join(",") +
          ");",
      )
      .join("\n") + "\n",
  );
  cursor = rows.at(-1).rowid;
}
const raw = run(
  [
    "d1",
    "execute",
    "DB",
    storageMode,
    "--command",
    "SELECT id,object_key,type FROM media ORDER BY id",
    "--json",
  ],
  true,
);
const rows = JSON.parse(raw).flatMap((r) => r.results || []);
if(rows.some(row=>!(/^[A-Za-z0-9_-]{1,128}$/).test(row.id)||typeof row.object_key!=='string'||row.object_key.length>1024))throw Error('Identificador de mídia inválido; backup recusado.');
for (const row of rows)
  run([
    "r2",
    "object",
    "get",
    cfg.r2_buckets[0].bucket_name + "/" + row.object_key,
    storageMode,
    "--file",
    path.join(dir, "media", row.id),
  ]);
const sha256={};
for(const name of ['database.sql',...rows.map(row=>'media/'+row.id)])sha256[name]=createHash('sha256').update(await readFile(path.join(dir,name))).digest('hex');
await writeFile(
  path.join(dir, "manifest.json"),
  JSON.stringify(
    {
      version: 2,
      source: {database_id: cfg.d1_databases[0].database_id, bucket: cfg.r2_buckets[0].bucket_name},
      created: new Date().toISOString(),
      media: rows,
      sha256,
      complete: true,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  "Backup concluído em " +
    dir +
    ". Guarde separadamente a MASTER_KEY. Mantenha o atendimento pausado durante cópias consistentes de banco e mídias.",
);
