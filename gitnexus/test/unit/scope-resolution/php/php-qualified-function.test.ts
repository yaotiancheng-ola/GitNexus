/**
 * PHP namespaced-function callees (#3498 follow-up).
 *
 * `rp\make()`, `\Qff\Mod\make()`, `Mod\make()` and `namespace\make()` name a
 * function through a path PHP reads against the calling file: its namespace and
 * its class/namespace `use` table. These tests pin the capture (the whole path
 * survives on the call site and the result binding) and the expansion to a fully
 * qualified name (PHP manual, "Name resolution rules").
 */
import { describe, expect, it, vi } from 'vitest';
import type { ParsedImport, ScopeId } from 'gitnexus-shared';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { phpProvider } from '../../../../src/core/ingestion/languages/php.js';
import {
  phpFunctionFqn,
  recordPhpFunctionIndex,
  resolvePhpQualifiedCallee,
} from '../../../../src/core/ingestion/languages/php/qualified-function.js';
import type { ScopeResolutionIndexes } from '../../../../src/core/ingestion/model/scope-resolution-indexes.js';
import * as safeParse from '../../../../src/core/tree-sitter/safe-parse.js';

const use = (
  localName: string,
  targetRaw: string,
  importedSymbolKind: 'type' | 'function' = 'type',
): ParsedImport => ({
  kind: 'alias',
  localName,
  importedName: targetRaw.split('\\').at(-1) ?? targetRaw,
  alias: localName,
  targetRaw,
  importedSymbolKind,
});

describe('PHP function ambiguity after a secondary parse timeout', () => {
  it('retains possible duplicates instead of selecting the remaining function', () => {
    const contents = new Map([
      ['known.php', '<?php namespace Ns; function make() {}'],
      ['multi.php', '<?php namespace Ns { function make() {} } namespace Other {}'],
      ['caller.php', '<?php function caller() {}'],
    ]);
    const parsed = [...contents].map(([file, source]) => {
      const value = extractParsedFile(phpProvider, source, file);
      if (value === undefined) throw new Error(`parse failed: ${file}`);
      return value;
    });
    const scopes = new Map(
      parsed.flatMap((file) => file.scopes.map((scope) => [scope.id, scope] as const)),
    );
    const indexes = {
      scopeTree: { getScope: (id: ScopeId) => scopes.get(id) },
    } as unknown as ScopeResolutionIndexes;
    const parse = vi.spyOn(safeParse, 'parseSourceSafe').mockImplementationOnce(() => {
      throw new safeParse.ParseTimeoutError(1, 'multi.php');
    });
    try {
      recordPhpFunctionIndex(
        parsed,
        indexes,
        new Map([
          ['known.php', 'Ns'],
          ['multi.php', 'Ns'],
          ['caller.php', ''],
        ]),
        { fileContents: contents },
      );
      const caller = parsed.find((file) => file.filePath === 'caller.php');
      if (caller === undefined) throw new Error('caller missing');
      expect(resolvePhpQualifiedCallee('\\Ns\\make', caller.moduleScope, indexes)).toBeUndefined();
    } finally {
      parse.mockRestore();
    }
  });
});

describe('phpFunctionFqn', () => {
  it.each([
    ['\\Qff\\Mod\\make', 'Qff\\App', [use('Qff', 'Other')], 'Qff\\Mod\\make'],
    ['\\make', 'Qff\\App', [], 'make'],
    ['namespace\\make', 'Qff\\Mod', [], 'Qff\\Mod\\make'],
    ['NAMESPACE\\Sub\\make', 'Qff', [], 'Qff\\Sub\\make'],
    ['namespace\\make', '', [], 'make'],
    ['rp\\make', 'Qff\\App', [use('rp', 'Qff\\Mod')], 'Qff\\Mod\\make'],
    ['RP\\make', 'Qff\\App', [use('rp', 'Qff\\Mod')], 'Qff\\Mod\\make'],
    ['rp\\Sub\\make', 'Qff\\App', [use('rp', '\\Qff\\Mod')], 'Qff\\Mod\\Sub\\make'],
    ['Mod\\make', 'Qff', [], 'Qff\\Mod\\make'],
    ['Mod\\make', '', [], 'Mod\\make'],
    ['rp\\make', 'Qff\\App', [use('rp', 'Qff\\Mod\\rp', 'function')], 'Qff\\App\\rp\\make'],
  ])(
    'expands %s in namespace "%s" to its fully qualified name',
    (callee, namespace, imports, fqn) => {
      expect(phpFunctionFqn(callee, { namespace, imports })).toBe(fqn);
    },
  );

  it.each([
    ['make', [use('make', 'Qff\\Mod\\make', 'function')]],
    ['rp\\', []],
    ['\\', []],
    ['$fn', []],
    ['rp\\$fn', []],
  ])('refuses %s, which names no qualified function', (callee, imports) => {
    expect(phpFunctionFqn(callee, { namespace: 'Qff\\App', imports })).toBeUndefined();
  });
});

describe('PHP qualified function-call captures', () => {
  it.each([
    ['rp\\make()', 'rp\\make'],
    ['\\Qff\\Mod\\make()', '\\Qff\\Mod\\make'],
    ['namespace\\make()', 'namespace\\make'],
  ])('keeps the callee path of %s and marks the binding as a call result', (call, path) => {
    const parsed = extractParsedFile(
      phpProvider,
      `<?php\nnamespace Qff\\App;\nfunction caller() { $x = ${call}; }\n`,
      'caller.php',
    );
    const calls = (parsed?.referenceSites ?? [])
      .filter((site) => site.kind === 'call')
      .map((site) => [site.name, site.rawQualifiedName, site.callForm]);
    expect(calls).toEqual([[path, path, 'free']]);
    const bound = (parsed?.scopes ?? [])
      .flatMap((scope) => [...scope.typeBindings])
      .filter(([name]) => name === '$x')
      .map(([, ref]) => ref.rawName);
    expect(bound).toEqual([call]);
  });
});
