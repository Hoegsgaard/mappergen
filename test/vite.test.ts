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
	realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, build } from 'vite';
import { mapperGen } from '../dist/vite.js';

const runtime = fileURLToPath(new URL('../dist/runtime.js', import.meta.url));

function fixture(t: TestContext) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mappergen-vite-')));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(join(dir, 'node_modules'));
	symlinkSync(dirname(dirname(runtime)), join(dir, 'node_modules/mappergen'), 'junction');
	writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
	writeFileSync(
		join(dir, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				target: 'ES2022',
				module: 'NodeNext',
				moduleResolution: 'NodeNext',
				types: [],
			},
			include: ['*Mapping.ts'],
		}),
	);
	const model = join(dir, 'models.ts');
	writeFileSync(
		model,
		'export interface Row { id: string; name: string; secret: string }\nexport interface Dto { id: string }\n',
	);
	const source = join(dir, 'UserMapping.ts');
	writeFileSync(
		source,
		`import { getMapper } from 'mappergen';
import type { Row, Dto } from './models.js';
/** @mapper */
export abstract class UserMapping {
  abstract toDto(source: Row): Dto;
}
export const userMapping = getMapper(UserMapping);
`,
	);
	return { dir, source, model };
}

async function change(server: import('vite').ViteDevServer, file: string, content: string) {
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			server.watcher.off('change', listener);
			reject(new Error(`Watcher did not observe ${file}`));
		}, 5000);
		function listener(changed: string) {
			if (changed !== file) return;
			clearTimeout(timeout);
			server.watcher.off('change', listener);
			resolve();
		}
		server.watcher.on('change', listener);
		writeFileSync(file, content);
	});
}

test('Vite reloads a mapper when its type-only dependency changes, and blocks invalid mappings', async (t) => {
	// Arrange
	const f = fixture(t);
	const server = await createServer({
		root: f.dir,
		configFile: false,
		logLevel: 'silent',
		plugins: [mapperGen({ project: 'tsconfig.json' })],
		server: {
			middlewareMode: true,
			hmr: false,
			watch: { usePolling: true, interval: 50 },
			fs: { allow: [f.dir, dirname(runtime)] },
		},
	});
	t.after(() => server.close());
	const row = { id: '1', name: 'Ada', secret: 'hidden' };
	const original = readFileSync(f.source, 'utf8');

	// Act
	const first = await server.ssrLoadModule(f.source);

	// Assert
	assert.deepEqual(first.userMapping.toDto(row), { id: '1' });

	// Arrange: extend the imported target without changing the mapper.
	const model = readFileSync(f.model, 'utf8');

	// Act
	await change(
		server,
		f.model,
		model.replace('Dto { id: string }', 'Dto { id: string; name: string }'),
	);
	const second = await server.ssrLoadModule(f.source);

	// Assert
	assert.deepEqual(second.userMapping.toDto(row), { id: '1', name: 'Ada' });

	// Act
	await change(
		server,
		f.model,
		model.replace('Dto { id: string }', 'Dto { id: string; missing: string }'),
	);

	// Assert: invalid edits must not return the previously generated mapper.
	await assert.rejects(server.ssrLoadModule(f.source), /Unmapped target 'missing'/);

	// Act
	await change(server, f.model, model);
	const recovered = await server.ssrLoadModule(f.source);

	// Assert: fixing the model restores a working mapper.
	assert.deepEqual(recovered.userMapping.toDto(row), { id: '1' });
	assert.equal(readFileSync(f.source, 'utf8'), original);
	assert.equal(
		readdirSync(f.dir).some((name) => name.includes('generated')),
		false,
	);
});

test('production bundle executes without compiler or generated source files', async (t) => {
	// Arrange
	const f = fixture(t);

	// Act
	const result = await build({
		root: f.dir,
		configFile: false,
		logLevel: 'silent',
		plugins: [mapperGen({ project: 'tsconfig.json' })],
		build: { ssr: f.source, write: false, minify: false },
	});
	if (Array.isArray(result) || !('output' in result))
		throw new Error('Expected one completed Vite build');
	const chunk = result.output.find((entry) => entry.type === 'chunk' && entry.isEntry);
	assert.ok(chunk && chunk.type === 'chunk');
	const module = await import(
		'data:text/javascript;base64,' + Buffer.from(chunk.code).toString('base64')
	);

	// Assert
	assert.deepEqual(module.userMapping.toDto({ id: '1', name: 'Ada', secret: 'hidden' }), {
		id: '1',
	});
	assert.equal(
		readdirSync(f.dir).some((name) => name.includes('generated')),
		false,
	);
});

test('production builds retain class imports used by generated constructors', async (t) => {
	// Arrange
	const f = fixture(t);
	writeFileSync(
		f.model,
		`export interface Row { id: string; name: string; secret: string }
export class Dto {
  id = '';
  label(): string { return 'User ' + this.id; }
}`,
	);
	writeFileSync(
		f.source,
		readFileSync(f.source, 'utf8').replace(
			"import type { Row, Dto } from './models.js';",
			"import { type Row, Dto } from './models.js';\nexport { Dto };",
		),
	);

	// Act
	const built = await build({
		root: f.dir,
		configFile: false,
		logLevel: 'silent',
		plugins: [mapperGen({ project: 'tsconfig.json' })],
		build: { ssr: f.source, write: false, minify: false },
	});
	if (Array.isArray(built) || !('output' in built))
		throw new Error('Expected one completed Vite build');
	const chunk = built.output.find((entry) => entry.type === 'chunk' && entry.isEntry);
	assert.ok(chunk && chunk.type === 'chunk');
	const module = await import(
		'data:text/javascript;base64,' + Buffer.from(chunk.code).toString('base64')
	);
	const result = module.userMapping.toDto({ id: '1', name: 'Ada', secret: 'hidden' });

	// Assert
	assert.ok(result instanceof module.Dto);
	assert.equal(result.label(), 'User 1');
	assert.equal(Object.hasOwn(result, 'secret'), false);
});

test('rejects an earlier plugin transformation instead of silently discarding its changes', async (t) => {
	// Arrange
	const f = fixture(t);
	const earlier: import('vite').Plugin = {
		name: 'earlier-transform',
		enforce: 'pre',
		transform(code, id) {
			if (id.replaceAll('\\', '/').endsWith('/UserMapping.ts'))
				return code + '\nexport const added = true;';
			return null;
		},
	};

	// Act
	const act = () =>
		build({
			root: f.dir,
			configFile: false,
			logLevel: 'silent',
			plugins: [earlier, mapperGen({ project: 'tsconfig.json' })],
			build: { ssr: f.source, write: false },
		});

	// Assert
	await assert.rejects(act(), /Place mapperGen\(\) before other pre-transform plugins/);
});

test('later plugins receive and preserve the generated mapper implementation', async (t) => {
	// Arrange
	const f = fixture(t);
	const later: import('vite').Plugin = {
		name: 'later-transform',
		enforce: 'pre',
		transform(code, id) {
			if (id.replaceAll('\\', '/').endsWith('/UserMapping.ts'))
				return code + '\nexport const added = true;';
			return null;
		},
	};

	// Act
	const built = await build({
		root: f.dir,
		configFile: false,
		logLevel: 'silent',
		plugins: [mapperGen({ project: 'tsconfig.json' }), later],
		build: { ssr: f.source, write: false },
	});
	if (Array.isArray(built) || !('output' in built))
		throw new Error('Expected one completed Vite build');
	const chunk = built.output.find((entry) => entry.type === 'chunk' && entry.isEntry);
	assert.ok(chunk && chunk.type === 'chunk');
	const module = await import(
		'data:text/javascript;base64,' + Buffer.from(chunk.code).toString('base64')
	);
	const result = module.userMapping.toDto({ id: '1', name: 'Ada', secret: 'hidden' });

	// Assert
	assert.equal(module.added, true);
	assert.deepEqual(result, { id: '1' });
});

test('browser bundles execute the public runtime without loading compiler or Vite dependencies', async (t) => {
	// Arrange
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mappergen-browser-')));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const entry = join(dir, 'entry.js');
	writeFileSync(
		entry,
		`import {getMapper} from 'mappergen';
class Mapping { toDto(source) { return { id: source.id }; } }
Object.defineProperty(Mapping, Symbol.for('mappergen/generated'), { value: true });
export const result = getMapper(Mapping).toDto({ id: '1', secret: 'hidden' });`,
	);
	const seen: string[] = [];

	// Act
	const built = await build({
		root: dir,
		configFile: false,
		logLevel: 'silent',
		resolve: { alias: { mappergen: dirname(dirname(runtime)) } },
		plugins: [
			{
				name: 'record-modules',
				transform(_code, id) {
					seen.push(id);
					return null;
				},
			},
		],
		build: { lib: { entry, formats: ['es'] }, write: false, minify: true },
	});
	const bundle = Array.isArray(built) ? built[0] : built;
	if (!bundle || !('output' in bundle)) throw new Error('Expected one completed Vite build');
	const chunk = bundle.output.find((entry) => entry.type === 'chunk' && entry.isEntry);
	assert.ok(chunk && chunk.type === 'chunk');
	const module = await import(
		'data:text/javascript;base64,' + Buffer.from(chunk.code).toString('base64')
	);

	// Assert
	assert.deepEqual(module.result, { id: '1' });
	assert.ok(seen.some((id) => id.endsWith('/dist/runtime.js')));
	assert.equal(
		seen.some((id) =>
			/(?:\/dist\/(?:generate|vite)\.js|\/node_modules\/)/.test(id.replaceAll('\\', '/')),
		),
		false,
	);
});

test('a source changed between loading and generation reports the race and can recover', async (t) => {
	// Arrange
	const f = fixture(t);
	const plugin = mapperGen({ project: join(f.dir, 'tsconfig.json') });
	const transform = plugin.transform;
	assert.equal(typeof transform, 'function');
	if (typeof transform !== 'function') throw new Error('Expected a transform hook');
	const context = {
		addWatchFile(_file: string) {},
		error(message: string): never {
			throw new Error(message);
		},
	};
	const loaded = readFileSync(f.source, 'utf8');
	const saved = loaded + '\n// A second save arrived before generation.\n';
	writeFileSync(f.source, saved);

	// Act
	const staleLoad = () => Reflect.apply(transform, context, [loaded, f.source]);

	// Assert
	assert.throws(staleLoad, /file may have changed during the build; retry after saving/);

	// Act: the next load receives the saved source.
	const recovered = await Reflect.apply(transform, context, [saved, f.source]);

	// Assert
	assert.match(recovered.code, /mappergen\/generated/);
	assert.match(recovered.code, /A second save arrived/);
});
