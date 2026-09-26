import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Exercise the actual distributable in a consumer outside the repository.
test('npm tarball exposes working declarations, CLI, compiler and runtime', () => {
	// Arrange
	const root = fileURLToPath(new URL('..', import.meta.url));
	const dir = mkdtempSync(join(tmpdir(), 'mappergen-package-'));
	const npmCli = process.env.npm_execpath;
	assert.ok(npmCli, 'Run package tests through npm test so the npm CLI path is available.');
	const run = (command: string, args: string[], cwd = dir): string =>
		execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	try {
		// Act: create the distributable.
		const packed: { filename: string; files: { path: string }[] }[] = JSON.parse(
			run(
				process.execPath,
				[npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', dir],
				root,
			),
		);
		const pack = packed[0];

		// Assert: ship the public package, without development files.
		assert.ok(pack);
		assert.ok(pack.files.some((file) => file.path === 'LICENSE'));
		assert.ok(pack.files.some((file) => file.path === 'src/runtime.ts'));
		assert.ok(pack.files.some((file) => file.path === 'dist/runtime.d.ts.map'));
		assert.ok(pack.files.some((file) => file.path === 'dist/runtime.d.ts'));
		assert.ok(pack.files.some((file) => file.path === 'dist/compiler/annotations.js'));
		assert.ok(!pack.files.some((file) => /^(test|node_modules|\.test-dist)\//.test(file.path)));

		// Arrange: create a separate consumer.
		// Keep the consumer reproducible when package dependencies use version ranges.
		const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
		const overrides = Object.fromEntries(
			Object.entries(lock.packages)
				.filter(
					([path]) =>
						path.startsWith('node_modules/') && !path.slice(13).includes('/node_modules/'),
				)
				.map(([path, entry]) => {
					const name = path.slice(13);
					const locked = entry as { name?: string; version: string };
					return [
						name,
						locked.name && locked.name !== name
							? `npm:${locked.name}@${locked.version}`
							: locked.version,
					];
				}),
		);
		writeFileSync(
			join(dir, 'package.json'),
			JSON.stringify({ private: true, type: 'module', overrides }),
		);

		// Act
		run(process.execPath, [
			npmCli,
			'install',
			join(dir, pack.filename),
			'--prefer-offline',
			'--no-audit',
			'--no-fund',
		]);
		const installed = JSON.parse(
			readFileSync(join(dir, 'node_modules/mappergen/package.json'), 'utf8'),
		);

		// Assert
		assert.equal(installed.license, 'MIT');
		assert.equal(existsSync(join(dir, 'node_modules/vite')), false);
		assert.equal(existsSync(join(dir, 'node_modules/mappergen/node_modules/vite')), false);

		// Arrange: use the installed public API, including its declarations.
		writeFileSync(
			join(dir, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					strict: true,
					module: 'NodeNext',
					target: 'ES2022',
					noEmit: true,
					types: [],
				},
				include: ['Mapping.ts'],
			}),
		);
		writeFileSync(
			join(dir, 'Mapping.ts'),
			`
import { getMapper } from 'mappergen';
/** @mapper */
export abstract class Mapping {
  /** @map target=name source=label */
  abstract toDto(source: { label: string; secret: string }): { name: string };
}
export const mapper = getMapper(Mapping);
export function checkTypes() {
  const name: string = mapper.toDto({label: 'Sensor', secret: 'Hidden'}).name;
  // @ts-expect-error The source signature must reject a numeric label.
  mapper.toDto({label: 1, secret: 'Hidden'});
  return name;
}
`,
		);

		// Act & Assert: compilation must succeed and the CLI must validate the mapper.
		run(process.execPath, ['node_modules/@typescript/typescript6/bin/tsc6']);
		assert.match(
			run(process.execPath, ['node_modules/mappergen/dist/cli.js', '--project', 'tsconfig.json']),
			/Validated 1 mapper/,
		);

		// Arrange: execute the generated implementation using only the installed package.
		writeFileSync(
			join(dir, 'run.js'),
			`
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import ts from '@typescript/typescript6';
import {generate} from 'mappergen/compiler';
const metadata = createRequire(import.meta.url)('mappergen/package.json');
assert.equal(metadata.name, 'mappergen');
const files = generate(ts, fileURLToPath(new URL('./tsconfig.json', import.meta.url)));
assert.equal(files.size, 1);
writeFileSync('Mapping.js', ts.transpileModule([...files.values()][0], {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}
}).outputText);
const {mapper} = await import('./Mapping.js');
assert.deepEqual(mapper.toDto({label: 'Sensor', secret: 'Hidden'}), {name: 'Sensor'});
`,
		);

		// Act & Assert: the consumer process asserts the mapped result.
		run(process.execPath, ['run.js']);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
