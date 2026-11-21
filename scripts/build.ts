import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = new URL("../src/", import.meta.url);
const destination = new URL("../dist/", import.meta.url);
const files = readdirSync(source)
  .filter((name) => name.endsWith(".ts"))
  .sort();
const available = new Set(files);
const outputs = files.map((name) => {
  const original = readFileSync(new URL(name, source), "utf8");
  const stripped = stripTypeScriptTypes(original, { mode: "strip" });
  const javascript = stripped.replace(
    /\b(from\s*|import\s*\(\s*|import\s*)(['"])([^'"]+)\2/gu,
    (statement: string, keyword: string, quote: string, specifier: string) => {
      if (!specifier.startsWith(".")) return statement;
      if (
        !/^\.\/[a-z][a-z0-9-]*\.ts$/u.test(specifier) ||
        !available.has(specifier.slice(2))
      ) {
        throw new Error(`Unsupported local import in ${name}: ${specifier}`);
      }
      return `${keyword}${quote}${specifier.slice(0, -3)}.js${quote}`;
    },
  );
  return { name: name.slice(0, -3) + ".js", javascript };
});

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
for (const output of outputs)
  writeFileSync(new URL(output.name, destination), output.javascript);
console.error(`Built ${outputs.length} JavaScript modules.`);
