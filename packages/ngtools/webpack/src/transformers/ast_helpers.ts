/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import { virtualFs } from '@angular-devkit/core';
import * as ts from 'typescript';
import { WebpackCompilerHost } from '../compiler_host';


// Find all nodes from the AST in the subtree of node of SyntaxKind kind.
export function collectDeepNodes<T extends ts.Node>(
  node: ts.Node,
  kind: ts.SyntaxKind | ts.SyntaxKind[],
): T[] {
  const kinds = Array.isArray(kind) ? kind : [kind];
  const nodes: T[] = [];
  const helper = (child: ts.Node) => {
    if (kinds.includes(child.kind)) {
      nodes.push(child as T);
    }
    ts.forEachChild(child, helper);
  };
  ts.forEachChild(node, helper);

  return nodes;
}

export function getFirstNode(sourceFile: ts.SourceFile): ts.Node {
  if (sourceFile.statements.length > 0) {
    return sourceFile.statements[0];
  }

  return sourceFile.getChildAt(0);
}

export function getLastNode(sourceFile: ts.SourceFile): ts.Node | null {
  if (sourceFile.statements.length > 0) {
    return sourceFile.statements[sourceFile.statements.length - 1] || null;
  }

  return null;
}


// Test transform helpers.
const basePath = '/project/src/';
const fileName = basePath + 'test-file.ts';

export function createTypescriptContext(content: string, additionalFiles?: Record<string, string>) {
  // Set compiler options.
  const compilerOptions: ts.CompilerOptions = {
    noEmitOnError: false,
    allowJs: true,
    newLine: ts.NewLineKind.LineFeed,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    target: ts.ScriptTarget.ESNext,
    skipLibCheck: true,
    sourceMap: false,
    importHelpers: true,
  };

  // Create compiler host.
  const compilerHost = new WebpackCompilerHost(
    compilerOptions,
    basePath,
    new virtualFs.SimpleMemoryHost(),
    false,
  );

  // Add a dummy file to host content.
  compilerHost.writeFile(fileName, content, false);

  if (additionalFiles) {
    for (const key in additionalFiles) {
      compilerHost.writeFile(basePath + key, additionalFiles[key], false);
    }
  }

  // Create the TypeScript program.
  const program = ts.createProgram([fileName], compilerOptions, compilerHost);

  return { compilerHost, program };
}

export function transformTypescript(
  content: string | undefined,
  transformers: ts.TransformerFactory<ts.SourceFile>[],
  program?: ts.Program,
  compilerHost?: WebpackCompilerHost,
) {

  // Use given context or create a new one.
  if (content !== undefined) {
    const typescriptContext = createTypescriptContext(content);
    program = typescriptContext.program;
    compilerHost = typescriptContext.compilerHost;
  } else if (!program || !compilerHost) {
    throw new Error('transformTypescript needs either `content` or a `program` and `compilerHost');
  }

  // Emit.
  const { emitSkipped, diagnostics } = program.emit(
    undefined, undefined, undefined, undefined, { before: transformers },
  );

  // Log diagnostics if emit wasn't successfull.
  if (emitSkipped) {
    console.error(diagnostics);

    return null;
  }

  // Return the transpiled js.
  return compilerHost.readFile(fileName.replace(/\.tsx?$/, '.js'));
}
