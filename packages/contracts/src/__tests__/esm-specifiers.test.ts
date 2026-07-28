import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * AST-based regression guard for Node ESM relative module specifiers.
 *
 * The shared packages are compiled to `dist` JavaScript that Node/Vercel loads
 * directly. Under `NodeNext` module resolution every relative import/export must
 * carry an explicit `.js` extension — an extensionless or `.ts` specifier fails at
 * runtime with `ERR_MODULE_NOT_FOUND`. This test parses each production source
 * file with the TypeScript compiler and asserts the invariant on real module
 * specifiers only: comments and unrelated string literals are ignored because we
 * read specifier nodes from the AST, not raw text.
 *
 * Scope: production source emitted to `dist` (the set compiled by
 * `tsconfig.build.json`). Test files (`*.test.ts`, anything under `__tests__/`)
 * are excluded — they never ship and are resolved by Vitest, not Node.
 *
 * It relies only on the `typescript` package (`ts.sys`), so it needs no `@types/node`
 * and no `import.meta` extensions. `ts.sys` paths are always forward-slash
 * normalized, making the file-system checks Windows/Linux compatible. It is pure
 * and read-only: no file mutation, no network, no environment access.
 */

const srcRoot = `${ts.sys.getCurrentDirectory()}/src`;

const productionSourceFiles = ts.sys.readDirectory(
  srcRoot,
  ['.ts'],
  ['**/*.test.ts', '**/*.d.ts', '**/__tests__/**'],
  ['**/*'],
);

interface ModuleSpecifier {
  readonly file: string;
  readonly value: string;
}

const collectModuleSpecifiers = (file: string): ModuleSpecifier[] => {
  const sourceText = ts.sys.readFile(file);
  if (sourceText === undefined) {
    throw new Error(`Unable to read source file: ${file}`);
  }
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const specifiers: ModuleSpecifier[] = [];
  const push = (value: string): void => {
    specifiers.push({ file, value });
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      push((node.arguments[0] as ts.StringLiteral).text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      push(node.argument.literal.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      push(node.moduleReference.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
};

const isRelative = (value: string): boolean => value.startsWith('./') || value.startsWith('../');

const posixDirname = (path: string): string => {
  const index = path.lastIndexOf('/');
  return index < 0 ? '.' : path.slice(0, index);
};

const resolveRelative = (fromFile: string, specifier: string): string => {
  const segments = posixDirname(fromFile).split('/');
  for (const part of specifier.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return segments.join('/');
};

const allSpecifiers = productionSourceFiles.flatMap(collectModuleSpecifiers);
const relativeSpecifiers = allSpecifiers.filter((s) => isRelative(s.value));

describe('Node ESM relative module specifiers', () => {
  it('scans the production source tree', () => {
    expect(productionSourceFiles.length).toBeGreaterThan(0);
    expect(relativeSpecifiers.length).toBeGreaterThan(0);
  });

  it('has no extensionless relative specifiers', () => {
    const offenders = relativeSpecifiers.filter((s) => !s.value.endsWith('.js'));
    expect(offenders).toEqual([]);
  });

  it('never uses a raw .ts relative specifier', () => {
    const offenders = relativeSpecifiers.filter((s) => s.value.endsWith('.ts'));
    expect(offenders).toEqual([]);
  });

  it('resolves every relative .js specifier to an existing .ts source', () => {
    const unresolved = relativeSpecifiers.filter((s) => {
      const withoutExtension = s.value.replace(/\.js$/, '');
      const asFile = `${resolveRelative(s.file, withoutExtension)}.ts`;
      const asIndex = `${resolveRelative(s.file, withoutExtension)}/index.ts`;
      return !ts.sys.fileExists(asFile) && !ts.sys.fileExists(asIndex);
    });
    expect(unresolved).toEqual([]);
  });
});
