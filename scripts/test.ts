/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
// tslint:disable:no-implicit-dependencies
import { logging } from '@angular-devkit/core';
import { spawnSync } from 'child_process';
import * as glob from 'glob';
import * as Istanbul from 'istanbul';
import 'jasmine';
import { SpecReporter as JasmineSpecReporter } from 'jasmine-spec-reporter';
import { ParsedArgs } from 'minimist';
import { join, normalize, relative } from 'path';
import { Position, SourceMapConsumer } from 'source-map';
import * as ts from 'typescript';
import { packages } from '../lib/packages';

const codeMap = require('../lib/istanbul-local').codeMap;
const Jasmine = require('jasmine');

const projectBaseDir = join(__dirname, '..');
require('source-map-support').install({
  hookRequire: true,
});


interface CoverageLocation {
  start: Position;
  end: Position;
}

type CoverageType = any;  // tslint:disable-line:no-any
declare const global: {
  __coverage__: CoverageType;
};


function _exec(command: string, args: string[], opts: { cwd?: string }, logger: logging.Logger) {
  const { status, error, stdout } = spawnSync(command, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    ...opts,
  });

  if (status != 0) {
    logger.error(`Command failed: ${command} ${args.map(x => JSON.stringify(x)).join(', ')}`);
    throw error;
  }

  return stdout.toString('utf-8');
}


// Add the Istanbul (not Constantinople) reporter.
const istanbulCollector = new Istanbul.Collector({});
const istanbulReporter = new Istanbul.Reporter(undefined, 'coverage/');
istanbulReporter.addAll(['json', 'lcov']);


class IstanbulReporter implements jasmine.CustomReporter {
  // Update a location object from a SourceMap. Will ignore the location if the sourcemap does
  // not have a valid mapping.
  private _updateLocation(consumer: SourceMapConsumer, location: CoverageLocation) {
    const start = consumer.originalPositionFor(location.start);
    const end = consumer.originalPositionFor(location.end);

    // Filter invalid original positions.
    if (start.line !== null && start.column !== null) {
      // Filter unwanted properties.
      location.start = { line: start.line, column: start.column };
    }
    if (end.line !== null && end.column !== null) {
      location.end = { line: end.line, column: end.column };
    }
  }

  private _updateCoverageJsonSourceMap(coverageJson: CoverageType) {
    // Update the coverageJson with the SourceMap.
    for (const path of Object.keys(coverageJson)) {
      const entry = codeMap.get(path);
      if (!entry) {
        continue;
      }

      const consumer = entry.map;
      const coverage = coverageJson[path];

      // Update statement maps.
      for (const branchId of Object.keys(coverage.branchMap)) {
        const branch = coverage.branchMap[branchId];
        let line: number | null = null;
        let column = 0;
        do {
          line = consumer.originalPositionFor({ line: branch.line, column: column++ }).line;
        } while (line === null && column < 100);

        branch.line = line;

        for (const location of branch.locations) {
          this._updateLocation(consumer, location);
        }
      }

      for (const id of Object.keys(coverage.statementMap)) {
        const location = coverage.statementMap[id];
        this._updateLocation(consumer, location);
      }

      for (const id of Object.keys(coverage.fnMap)) {
        const fn = coverage.fnMap[id];
        fn.line = consumer.originalPositionFor({ line: fn.line, column: 0 }).line;
        this._updateLocation(consumer, fn.loc);
      }
    }
  }

  jasmineDone(_runDetails: jasmine.RunDetails): void {
    if (global.__coverage__) {
      this._updateCoverageJsonSourceMap(global.__coverage__);
      istanbulCollector.add(global.__coverage__);

      istanbulReporter.write(istanbulCollector, true, () => {});
    }
  }
}


// Create a Jasmine runner and configure it.
const runner = new Jasmine({ projectBaseDir: projectBaseDir });

if (process.argv.indexOf('--spec-reporter') != -1) {
  runner.env.clearReporters();
  runner.env.addReporter(new JasmineSpecReporter({
    stacktrace: {
      // Filter all JavaScript files that appear after a TypeScript file (callers) from the stack
      // trace.
      filter: (x: string) => {
        return x.substr(0, x.indexOf('\n', x.indexOf('\n', x.lastIndexOf('.ts:')) + 1));
      },
    },
    spec: {
      displayDuration: true,
    },
    suite: {
      displayNumber: true,
    },
    summary: {
      displayStacktrace: true,
      displayErrorMessages: true,
      displayDuration: true,
    },
  }));
}


// Manually set exit code (needed with custom reporters)
runner.onComplete((success: boolean) => {
  process.exitCode = success ? 0 : 1;
  if (process.platform.startsWith('win')) {
    // TODO(filipesilva): finish figuring out why this happens.
    // We should not need to force exit here, but when:
    // - on windows
    // - running webpack-dev-server
    // - with ngtools/webpack on the compilation
    // Something seems to hang and the process never exists.
    // This does not happen on linux, nor with webpack on watch mode.
    // Until this is figured out, we need to exit the process manually after tests finish
    // otherwise appveyor will hang until it timeouts.
    process.exit();
  }
});


glob.sync('packages/**/*.spec.ts')
  .filter(p => !/\/schematics\/.*\/(other-)?files\//.test(p))
  .forEach(path => {
    console.error(`Invalid spec file name: ${path}. You're using the old convention.`);
  });

export default function (args: ParsedArgs, logger: logging.Logger) {
  const specGlob = args.large ? '*_spec_large.ts' : '*_spec.ts';
  const regex = args.glob ? args.glob : `packages/**/${specGlob}`;

  if (args['code-coverage']) {
    runner.env.addReporter(new IstanbulReporter());
  }

  if (args.large) {
    // Default timeout for large specs is 2.5 minutes.
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 150000;
  }

  if (args.timeout && Number.parseInt(args.timeout) > 0) {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = Number.parseInt(args.timeout);
  }

  // Run the tests.
  const allTests =
    glob.sync(regex)
      .map(p => relative(projectBaseDir, p));

  const tsConfigPath = join(__dirname, '../tsconfig.json');
  const tsConfig = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
  const pattern = '^('
                  + (tsConfig.config.exclude as string[])
                    .map(ex => '('
                      + ex.split(/[\/\\]/g).map(f => f
                          .replace(/[\-\[\]{}()+?.^$|]/g, '\\$&')
                          .replace(/^\*\*/g, '(.+?)?')
                          .replace(/\*/g, '[^/\\\\]*'))
                        .join('[\/\\\\]')
                      + ')')
                    .join('|')
                  + ')($|/|\\\\)';
  const excludeRe = new RegExp(pattern);
  let tests = allTests.filter(x => !excludeRe.test(x));

  if (!args.full) {
    // Find the point where this branch merged with master.
    const branch = _exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {}, logger).trim();
    const masterRevList = _exec('git', ['rev-list', 'master'], {}, logger).trim().split('\n');
    const branchRevList = _exec('git', ['rev-list', branch], {}, logger).trim().split('\n');
    const sha = branchRevList.find(s => masterRevList.includes(s));

    if (sha) {
      const diffFiles = [
        // Get diff between $SHA and HEAD.
        ..._exec('git', ['diff', sha, 'HEAD', '--name-only'], {}, logger)
          .trim().split('\n'),
        // And add the current status to it (so it takes the non-committed changes).
        ..._exec('git', ['status', '--short', '--show-stash'], {}, logger)
          .split('\n').map(x => x.slice(2).trim()),
      ]
        .map(x => normalize(x))
        .filter(x => x !== '.' && x !== '');  // Empty paths will be normalized to dot.

      const diffPackages = new Set();
      for (const pkgName of Object.keys(packages)) {
        const relativeRoot = relative(projectBaseDir, packages[pkgName].root);
        if (diffFiles.some(x => x.startsWith(relativeRoot))) {
          diffPackages.add(pkgName);
          // Add all reverse dependents too.
          packages[pkgName].reverseDependencies.forEach(d => diffPackages.add(d));
        }
      }

      // Show the packages that we will test.
      logger.info(`Found ${diffPackages.size} packages:`);
      logger.info(JSON.stringify([...diffPackages], null, 2));

      // Remove the tests from packages that haven't changed.
      tests = tests
        .filter(p => Object.keys(packages).some(name => {
          const relativeRoot = relative(projectBaseDir, packages[name].root);

          return p.startsWith(relativeRoot) && diffPackages.has(name);
        }));

      logger.info(`Found ${tests.length} spec files, out of ${allTests.length}.`);

      if (tests.length === 0) {
        logger.info('No test to run, exiting... You might want to rerun with "--full".');
        process.exit('CI' in process.env ? 1 : 0);
      }
    }
  }

  if (args.shard !== undefined) {
    // Remove tests that are not part of this shard.
    const shardId = args['shard'];
    const nbShards = args['nb-shards'] || 2;
    tests = tests.filter((name, i) => (i % nbShards) == shardId);
  }

  return new Promise(resolve => {
    runner.onComplete((passed: boolean) => resolve(passed ? 0 : 1));
    if (args.seed != undefined) {
      runner.seed(args.seed);
    }

    runner.execute(tests, args.filter);
  });
}
