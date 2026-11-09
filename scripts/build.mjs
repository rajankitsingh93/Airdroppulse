import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist");

await mkdir(output, { recursive: true });
for (const file of ["index.html", "styles.css", "app.js"]) {
  await cp(path.join(root, file), path.join(output, file));
}
console.log("Built Airdroppulse static assets in dist/.");