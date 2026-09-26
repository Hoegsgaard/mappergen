import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from '@typescript/typescript6';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { build } from 'vite';
import { generateWithMaps } from 'mappergen/compiler';
import { mapperGen } from '../dist/vite.js';

const runtime = fileURLToPath(new URL('../dist/runtime.js', import.meta.url));

test('source maps preserve converter lines after multiple generated methods, including production stacks', async (t) => {
	// Arrange
	const dir = mkdtempSync(join(tmpdir(), 'mappergen-maps-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(join(dir, 'node_modules'));
	symlinkSync(dirname(dirname(runtime)), join(dir, 'node_modules/mappergen'), 'junction');
	const file = join(dir, 'SensorMapping.ts');
	const source = `import { getMapper } from 'mappergen';
/** @mapper */
export abstract class SensorMapping {
  abstract first(source: { id: string }): { id: string };
  /** @convert reading convert */
  abstract second(source: { reading: string }): { reading: number };
  protected convert(value: string): number {
    throw new Error('Invalid reading: ' + value);
  }
}
export const mapping = getMapper(SensorMapping);
`;
	writeFileSync(file, source);
	writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
	writeFileSync(
		join(dir, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true, types: [] },
			include: ['SensorMapping.ts'],
		}),
	);

	// Act: generate and resolve positions in the source map.
	const output = generateWithMaps(ts, join(dir, 'tsconfig.json')).get(file);
	assert.ok(output);
	const trace = new TraceMap(output.map.toString());
	const lines = output.code.split('\n');
	const throwLine = source.split('\n').findIndex((line) => line.includes('throw new Error')) + 1;
	const generatedThrow = lines.findIndex((line) => line.includes('throw new Error'));
	const position = originalPositionFor(trace, {
		line: generatedThrow + 1,
		column: lines[generatedThrow]!.indexOf('throw'),
	});

	// Assert
	assert.equal(position.line, throwLine);
	assert.equal(position.column, 4);
	const generatedRead = lines.findIndex((line) => line.includes('this.convert('));
	const methodPosition = originalPositionFor(trace, {
		line: generatedRead + 1,
		column: lines[generatedRead]!.indexOf('this.convert'),
	});
	assert.equal(methodPosition.line, 6);
	assert.deepEqual(output.map.sourcesContent, [source]);

	// Act: exercise the maps through a production build and a real Node stack trace.
	await build({
		root: dir,
		configFile: false,
		logLevel: 'silent',
		plugins: [mapperGen({ project: 'tsconfig.json' })],
		build: { ssr: file, sourcemap: true, minify: false, outDir: join(dir, 'dist') },
	});
	writeFileSync(
		join(dir, 'run.js'),
		`import { mapping } from './dist/SensorMapping.js';\ntry { mapping.second({reading:'bad'}); } catch(error) { console.log(error.stack); }`,
	);
	const stack = execFileSync(process.execPath, ['--enable-source-maps', join(dir, 'run.js')], {
		encoding: 'utf8',
	});

	// Assert
	assert.ok(stack.includes(`SensorMapping.ts:${throwLine}:`), stack);
	assert.ok(stack.includes('SensorMapping.ts:6:'), stack);
});
