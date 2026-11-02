import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = new URL("./", import.meta.url),
  dist = new URL("./dist/", root);
await mkdir(dist, { recursive: true });
for (const file of ["index.html", "styles.css", "favicon.svg"])
  await cp(new URL(file, root), new URL(file, dist));
console.log(
  `Institutional source built at ${fileURLToPath(dist)}. No deployment performed.`,
);
