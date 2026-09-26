import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
	mkdirSync,
	symlinkSync,
	mkdtempSync,
	writeFileSync,
	readFileSync,
	readdirSync,
	rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from '@typescript/typescript6';
import { generate } from 'mappergen/compiler';
import { getMapper } from 'mappergen';

const runtime = fileURLToPath(new URL('../dist/runtime.js', import.meta.url));

function fixture(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), 'mappergen-transform-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(join(dir, 'node_modules'));
	symlinkSync(dirname(dirname(runtime)), join(dir, 'node_modules/mappergen'), 'junction');
	writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
	const project = join(dir, 'tsconfig.json');
	const options = {
		strict: true,
		target: 'ES2022',
		module: 'NodeNext',
		moduleResolution: 'NodeNext',
		types: [],
		outDir: 'dist',
	};
	writeFileSync(project, JSON.stringify({ compilerOptions: options, include: ['*.ts'] }));
	const source = join(dir, 'SensorMapping.ts');
	writeFileSync(
		source,
		`import { getMapper } from 'mappergen';
interface Row { id: string; sensorName: string; reading: string; secret: string }
interface Dto { id: string; name: string; reading: number }
/** @mapper */
export abstract class SensorMapping {
  /**
   * @map target=name source=sensorName
   * @convert reading convert
   */
  abstract toDto(row: Row): Dto;
  protected convert(value: string): number { return Number(value); }
}
export const sensorMapping = getMapper(SensorMapping);
`,
	);
	return { dir, project, source };
}

test('single source-file API executes generated methods without writing generated TS files', async (t) => {
	// Arrange
	const f = fixture(t);
	const original = readFileSync(f.source, 'utf8');

	// Act: generate, compile and load the mapper as a consumer would.
	const compiled = generate(ts, f.project);
	const parsed = ts.parseJsonConfigFileContent(
		ts.readConfigFile(f.project, ts.sys.readFile).config,
		ts.sys,
		f.dir,
	);
	const host = ts.createCompilerHost(parsed.options);
	const read = host.readFile.bind(host);
	host.readFile = (file) => compiled.get(resolve(file)) ?? read(file);
	const program = ts.createProgram(parsed.fileNames, parsed.options, host);
	assert.deepEqual(ts.getPreEmitDiagnostics(program), []);
	assert.equal(program.emit().emitSkipped, false);
	const { sensorMapping, SensorMapping } = await import(
		pathToFileURL(join(f.dir, 'dist', 'SensorMapping.js')).href
	);
	const result = sensorMapping.toDto({
		id: '1',
		sensorName: 'outdoor',
		reading: '12.50',
		secret: 'hidden',
	});
	const repeated = getMapper(SensorMapping);

	// Assert
	assert.equal(readFileSync(f.source, 'utf8'), original);
	assert.equal(
		readdirSync(f.dir).some((name) => name.includes('generated')),
		false,
	);
	assert.deepEqual(result, {
		id: '1',
		name: 'outdoor',
		reading: 12.5,
	});
	assert.equal(repeated, sensorMapping);
});

test('transformation detects new required target fields and never edits the contract', (t) => {
	// Arrange
	const f = fixture(t);
	const original = readFileSync(f.source, 'utf8').replace(
		'interface Dto { id: string;',
		'interface Dto { required: string; id: string;',
	);
	writeFileSync(f.source, original);

	// Act & Assert
	assert.throws(() => generate(ts, f.project), /Unmapped target 'required'/);
	assert.equal(readFileSync(f.source, 'utf8'), original);
});

test('missing build integration fails immediately with an actionable error', () => {
	// Arrange
	class NotGenerated {}

	// Act & Assert
	assert.throws(() => getMapper(NotGenerated), /Enable mapperGen/);
});

test('a subclass cannot accidentally inherit a generated marker', () => {
	// Arrange
	class Generated {}
	Object.defineProperty(Generated, Symbol.for('mappergen/generated'), { value: true });
	class NotGenerated extends Generated {}

	// Act & Assert
	assert.throws(() => getMapper(NotGenerated), /has not been generated/);
});

test('CLI validates without writing files', (t) => {
	// Arrange
	const f = fixture(t);
	const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
	const before = readdirSync(f.dir).sort();

	// Act
	const result = spawnSync(process.execPath, [cli, '--project', f.project], { encoding: 'utf8' });

	// Assert
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Validated 1 mapper/);
	assert.deepEqual(readdirSync(f.dir).sort(), before);
});

for (const args of [['--check'], ['--typescript'], ['--project'], ['--project', '--validate']]) {
	test(`CLI rejects invalid arguments: ${args.join(' ')}`, () => {
		// Arrange
		const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

		// Act
		const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

		// Assert
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Unknown argument|Missing value for --project/);
		assert.doesNotMatch(result.stdout, /Validated/);
	});
}

test('runtime reuses each mapper instance without sharing instances between contracts', () => {
	// Arrange
	class First {}
	class Second {}
	for (const contract of [First, Second]) {
		Object.defineProperty(contract, Symbol.for('mappergen/generated'), { value: true });
	}

	// Act
	const first = getMapper(First);
	const repeated = getMapper(First);
	const second = getMapper(Second);

	// Assert
	assert.equal(repeated, first);
	assert.notEqual(second, first);
	assert.ok(first instanceof First);
	assert.ok(second instanceof Second);
});

test('CLI exits unsuccessfully and reports the mapping error for an invalid project', (t) => {
	// Arrange
	const f = fixture(t);
	writeFileSync(
		f.source,
		readFileSync(f.source, 'utf8').replace(
			'interface Dto { id: string;',
			'interface Dto { missing: string; id: string;',
		),
	);
	const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

	// Act
	const result = spawnSync(process.execPath, [cli, '--project', f.project, '--validate'], {
		encoding: 'utf8',
	});

	// Assert
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Unmapped target 'missing'/);
	assert.doesNotMatch(result.stdout, /Validated/);
});
