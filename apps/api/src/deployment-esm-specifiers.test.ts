import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Runtime regression guard for the Node ESM **relative module specifier** contract.
 *
 * `apps/api` ships as `"type": "module"`, and Vercel's Hono build transpiles each TypeScript module to an
 * ESM `.js` file while preserving the import/export specifier strings verbatim. Node's ESM loader does NOT
 * perform extension resolution for relative specifiers, so an extensionless `from './api-app'` stays
 * extensionless in the emitted `index.js` and the function crashes at startup with `ERR_MODULE_NOT_FOUND`
 * (exactly the PR #31 `GET /health` → 500 `FUNCTION_INVOCATION_FAILED`, on
 * `/var/task/apps/api/src/api-app` imported from `/var/task/apps/api/src/index.js`).
 *
 * This test pins the fix: every relative TypeScript module reference under `apps/api/src` (production and
 * test source alike) must use an explicit `.js` specifier that maps back to a real on-disk `.ts` module, and
 * every barrel/directory import must be an explicit `/index.js` (which maps to `/index.ts` under the same
 * rule). It parses each file with the TypeScript compiler API — never a naive string scan, so example
 * strings in comments or data are not false positives — collecting specifiers from `import`, `export`, and
 * dynamic `import()` nodes only. It touches no network / environment / Vercel API, mutates nothing, and
 * lets `path` normalize separators so it passes identically on Windows and CI Linux.
 */

// This test file lives at `apps/api/src/deployment-esm-specifiers.test.ts`, so its directory is the api `src/`.
const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/** Every `.ts` file under `apps/api/src`, recursively (production and test source alike). */
function collectTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectTypeScriptFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

/** A relative module specifier together with the source file that referenced it. */
interface RelativeSpecifier {
  readonly file: string;
  readonly specifier: string;
}

/** Collects every relative (`./` or `../`) specifier referenced by import / export / dynamic `import()`. */
function collectRelativeSpecifiers(file: string): RelativeSpecifier[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const found: RelativeSpecifier[] = [];

  const record = (specifier: string): void => {
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      found.push({ file, specifier });
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      record(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      record(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
}

const relativeSpecifiers = collectTypeScriptFiles(SRC_DIR).flatMap(collectRelativeSpecifiers);

describe('Node ESM relative module specifiers (apps/api/src)', () => {
  it('uses explicit .js specifiers for every relative TypeScript module reference', () => {
    // Sanity: the AST collector actually walked real imports (guards against a silent no-op pass).
    expect(relativeSpecifiers.length).toBeGreaterThan(0);

    const problems: string[] = [];
    for (const { file, specifier } of relativeSpecifiers) {
      if (!specifier.endsWith('.js')) {
        problems.push(`${file}: '${specifier}' is missing the explicit .js extension`);
        continue;
      }
      // The emitted `.js` specifier must map back to a real on-disk `.ts` module; a barrel `/index.js`
      // maps to `/index.ts` under the very same substitution.
      const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
      if (!existsSync(target)) {
        problems.push(`${file}: '${specifier}' does not resolve to an existing .ts module`);
      }
    }

    expect(problems, problems.join('\n')).toEqual([]);
  });
});
