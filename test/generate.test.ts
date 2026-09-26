import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generate } from 'mappergen/compiler';

import ts from '@typescript/typescript6';

function fixture(t: TestContext, contract: string, compilerOptions: Record<string, unknown> = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'mappergen-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
	const project = join(dir, 'tsconfig.json');
	writeFileSync(
		project,
		JSON.stringify({
			compilerOptions: {
				strict: true,
				target: 'ES2022',
				module: 'NodeNext',
				moduleResolution: 'NodeNext',
				types: [],
				outDir: 'dist',
				...compilerOptions,
			},
			include: ['*.ts'],
		}),
	);
	const source = join(dir, 'Contract.ts');
	writeFileSync(source, contract);
	return { dir, project, source };
}

async function execute(f: ReturnType<typeof fixture>) {
	const config = ts.readConfigFile(f.project, ts.sys.readFile);
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, f.dir);
	const compiled = generate(ts, f.project);
	const host = ts.createCompilerHost(parsed.options);
	const read = host.readFile.bind(host);
	host.readFile = (file) => compiled.get(resolve(file)) ?? read(file);
	const program = ts.createProgram(parsed.fileNames, parsed.options, host);
	assert.equal(ts.getPreEmitDiagnostics(program).length, 0);
	assert.equal(program.emit().emitSkipped, false);
	const module = await import(pathToFileURL(join(f.dir, 'dist', 'Contract.js')).href);
	return new module.Mapper();
}

test('generates executable methods; maps inherited fields and converters; excludes internal fields', async (t) => {
	// Arrange
	const f = fixture(
		t,
		`
interface Base { id: string }
interface Row extends Base { sensorName: string; reading: string; description: string | null; secret: string }
interface Dto extends Base { name: string; reading: number; description?: string }
/** @mapper */
export abstract class Mapper {
  /**
   * @map target=name source=sensorName
   * @convert reading number
   * @convert description optional
   */
  abstract toDto(source: Row): Dto;
  protected number(value: string): number { return Number(value); }
  protected optional(value: string | null): string | undefined { return value ?? undefined; }
}
`,
	);

	const source = {
		id: '1',
		sensorName: 'outdoor',
		reading: '12.50',
		description: null,
		secret: 'hidden',
	};

	// Act
	const mapper = await execute(f);
	const result = mapper.toDto(source);

	// Assert
	assert.deepEqual(result, { id: '1', name: 'outdoor', reading: 12.5, description: undefined });
});

for (const { name, signature, expected } of [
	{
		name: 'rejects a target field without a source',
		signature: 'abstract toDto(source: { id: string }): { id: string; required: number };',
		expected: /Unmapped target 'required'/,
	},
	{
		name: 'rejects incompatible types even when field names match',
		signature: 'abstract toDto(source: { id: number }): { id: string };',
		expected: /number is not assignable to string/,
	},
]) {
	test(name, (t) => {
		// Arrange
		const f = fixture(
			t,
			`/** @mapper */
export abstract class Mapper { ${signature} }`,
		);

		// Act & Assert
		assert.throws(() => generate(ts, f.project), expected);
	});
}

test('rejects implicitly copied nested objects even when structurally assignable', (t) => {
	// Arrange
	const f = fixture(
		t,
		`/** @mapper */
export abstract class Mapper {
  abstract toDto(source: { user: { id: string; secret: string } }): { user: { id: string } };
}`,
	);

	// Act & Assert
	assert.throws(() => generate(ts, f.project), /nested-object\/array copying is disabled/);
});

for (const { name, converter, expected } of [
	{
		name: 'rejects a converter that cannot accept the source type',
		converter: 'protected convert(value: boolean): number { return Number(value); }',
		expected: /cannot accept field/,
	},
	{
		name: 'rejects a converter that cannot produce the target type',
		converter: 'protected convert(value: string): string { return value; }',
		expected: /cannot produce target/,
	},
]) {
	test(name, (t) => {
		// Arrange
		const f = fixture(
			t,
			`/** @mapper */
export abstract class Mapper {
  /** @convert reading convert */
  abstract toDto(source: { reading: string }): { reading: number };
  ${converter}
}`,
		);

		// Act & Assert
		assert.throws(() => generate(ts, f.project), expected);
	});
}

test('preserves absent optional properties with exactOptionalPropertyTypes', async (t) => {
	// Arrange
	const f = fixture(
		t,
		`/** @mapper */
export abstract class Mapper {
  abstract toDto(source: { id: string; note?: string }): { id: string; note?: string };
}`,
		{ exactOptionalPropertyTypes: true },
	);

	// Act
	const mapper = await execute(f);

	const absent = mapper.toDto({ id: '1' });
	const present = mapper.toDto({ id: '1', note: 'hello' });

	// Assert
	assert.deepEqual(absent, { id: '1' });
	assert.deepEqual(present, { id: '1', note: 'hello' });
});

test('rejects unresolved imported types instead of generating from any', (t) => {
	// Arrange
	const f = fixture(
		t,
		`import type { Missing } from './missing.js';
/** @mapper */
export abstract class Mapper { abstract toDto(source: Missing): { id: string }; }`,
	);

	// Act & Assert
	assert.throws(() => generate(ts, f.project), /Source must be a concrete object shape/);
});

test('compiler diagnostics block output when a handwritten converter is invalid', (t) => {
	// Arrange
	const f = fixture(
		t,
		`/** @mapper */
export abstract class Mapper {
  /** @convert reading convert */
  abstract toDto(source: { reading: string }): { reading: number };
  protected convert(value: string): number { return value; }
}`,
	);

	// Act & Assert
	assert.throws(() => generate(ts, f.project), /not assignable to type 'number'/);
	assert.deepEqual(readdirSync(f.dir).sort(), ['Contract.ts', 'package.json', 'tsconfig.json']);
});

test('does not overwrite handwritten files', (t) => {
	// Arrange
	const f = fixture(
		t,
		`/** @mapper */
export abstract class Mapper { abstract toDto(source: { id: string }): { id: string }; }`,
	);
	const original = readFileSync(f.source, 'utf8');
	const unrelated = join(f.dir, 'unrelated.ts');
	writeFileSync(unrelated, '// handwritten\n');

	// Act
	generate(ts, f.project);

	// Assert
	assert.equal(readFileSync(f.source, 'utf8'), original);
	assert.equal(readFileSync(unrelated, 'utf8'), '// handwritten\n');
	assert.deepEqual(readdirSync(f.dir).sort(), [
		'Contract.ts',
		'package.json',
		'tsconfig.json',
		'unrelated.ts',
	]);
});

test('named mapping arguments accept either order and whitespace around equals', async (t) => {
	// Arrange
	const f = fixture(
		t,
		`/** @mapper */
export abstract class Mapper {
  /** @map source = sensorName target = name */
  abstract toDto(source: { sensorName: string }): { name: string };
}`,
	);

	// Act
	const mapper = await execute(f);

	const result = mapper.toDto({ sensorName: 'outdoor' });

	// Assert
	assert.deepEqual(result, { name: 'outdoor' });
});

test('named mapping arguments reject ambiguous syntax and misspelled field references', (t) => {
	// Arrange
	const f = fixture(t, '');
	for (const [annotation, expected] of [
		['name sensorName', /Expected @map target=/],
		['target=name', /Expected @map target=/],
		['target=name target=sensorName', /Expected @map target=/],
		['target=name sorce=sensorName', /Expected @map target=/],
		['target=name source=sensorName extra=value', /Expected @map target=/],
		['target=Name source=sensorName', /Unknown target field 'Name'/],
		['target=name source=sensorNAME', /source field 'sensorNAME' is missing/],
	] as const) {
		writeFileSync(
			f.source,
			`/** @mapper */
export abstract class Mapper {
  /** @map ${annotation} */
  abstract toDto(source: { sensorName: string }): { name: string };
}`,
		);

		// Act & Assert
		assert.throws(() => generate(ts, f.project), expected, annotation);
		assert.deepEqual(readdirSync(f.dir).sort(), ['Contract.ts', 'package.json', 'tsconfig.json']);
	}
});

for (const { name, annotation, converter, expected } of [
	{
		name: 'missing converter method',
		annotation: '@convert value missing',
		converter: '',
		expected: /Converter 'missing' must be/,
	},
	{
		name: 'private converter method',
		annotation: '@convert value convert',
		converter: 'private convert(value: string): number { return Number(value); }',
		expected: /public\/protected instance method/,
	},
	{
		name: 'static converter method',
		annotation: '@convert value convert',
		converter: 'static convert(value: string): number { return Number(value); }',
		expected: /instance method/,
	},
	{
		name: 'duplicate mapping rule',
		annotation: '@map target=value source=input\n   * @map target=value source=input',
		converter: '',
		expected: /Duplicate @map/,
	},
	{
		name: 'duplicate converter rule',
		annotation: '@convert value convert\n   * @convert value convert',
		converter: '',
		expected: /Duplicate @convert/,
	},
	{
		name: 'malformed converter rule',
		annotation: '@convert value',
		converter: '',
		expected: /Expected @convert/,
	},
]) {
	test(`rejects ${name} with an actionable diagnostic`, (t) => {
		// Arrange
		const f = fixture(
			t,
			`/** @mapper */
export abstract class Mapper {
  /** ${annotation} */
  abstract toDto(source: { input: string; value: string }): { value: number };
  ${converter}
}`,
		);

		// Act & Assert
		assert.throws(() => generate(ts, f.project), expected);
	});
}

test('explicit converters map nested objects and arrays without exposing internal fields', async (t) => {
	// Arrange
	const f = fixture(
		t,
		`
interface UserRow { id: string; secret: string }
interface UserDto { id: string }
/** @mapper */
export abstract class Mapper {
  /**
   * @convert user toUser
   * @convert users toUsers
   */
  abstract toDto(source: { user: UserRow; users: UserRow[] }): { user: UserDto; users: UserDto[] };
  protected toUser(user: UserRow): UserDto { return { id: user.id }; }
  protected toUsers(users: UserRow[]): UserDto[] { return users.map(user => this.toUser(user)); }
}`,
	);
	const source = { user: { id: '1', secret: 'hidden' }, users: [{ id: '2', secret: 'hidden' }] };
	const original = structuredClone(source);

	// Act
	const mapper = await execute(f);
	const result = mapper.toDto(source);

	// Assert
	assert.deepEqual(result, { user: { id: '1' }, users: [{ id: '2' }] });
	assert.deepEqual(source, original);
	assert.notEqual(result.user, source.user);
	assert.notEqual(result.users, source.users);
});

test('generates multiple mapper classes and methods in the same file', async (t) => {
	// Arrange
	const f = fixture(
		t,
		`/** @mapper */
export abstract class OtherMapper {
  abstract toDto(source: { name: string; secret: string }): { name: string };
}
/** @mapper */
export abstract class Mapper {
  abstract toDto(source: { id: string; secret: string }): { id: string };
  abstract toName(source: { name: string }): { name: string };
  other(source: { name: string; secret: string }): { name: string } {
    const Concrete = OtherMapper as new () => OtherMapper;
    return new Concrete().toDto(source);
  }
}`,
	);

	// Act
	const mapper = await execute(f);
	const result = mapper.toDto({ id: '1', secret: 'hidden' });
	const name = mapper.toName({ name: 'Ada' });
	const other = mapper.other({ name: 'Grace', secret: 'hidden' });

	// Assert
	assert.deepEqual(result, { id: '1' });
	assert.deepEqual(name, { name: 'Ada' });
	assert.deepEqual(other, { name: 'Grace' });
});

test('reports imported model dependencies and produces stable output across repeated generation', (t) => {
	// Arrange
	const f = fixture(
		t,
		`import type { Row, Dto } from './models.js';
/** @mapper */
export abstract class Mapper { abstract toDto(source: Row): Dto; }`,
	);
	const model = join(f.dir, 'models.ts');
	writeFileSync(model, 'export interface Row { id: string }\nexport interface Dto { id: string }');
	let dependencies: readonly string[] = [];

	// Act
	const first = generate(ts, f.project, {
		onDependencies(files) {
			dependencies = files;
		},
	});
	const second = generate(ts, f.project);

	// Assert
	assert.deepEqual(first, second);
	assert.ok(dependencies.map((file) => resolve(file)).includes(model));
	assert.ok(dependencies.map((file) => resolve(file)).includes(f.source));
	assert.deepEqual([...first.keys()], [f.source]);
});

test('rejects projects without strict null checks before generating unsafe mappings', (t) => {
	// Arrange
	const f = fixture(
		t,
		`/** @mapper */
export abstract class Mapper { abstract toDto(source: { id: string | null }): { id: string }; }`,
		{ strict: false },
	);

	// Act & Assert
	assert.throws(() => generate(ts, f.project), /strictNullChecks \(or strict\) must be enabled/);
});

test('reports when the selected project contains no mapper contracts', (t) => {
	// Arrange
	const f = fixture(t, 'export interface User { id: string }');

	// Act & Assert
	assert.throws(() => generate(ts, f.project), /No @mapper contracts found/);
});

for (const { name, source, target, expected } of [
	{
		name: 'arrays need an explicit converter',
		source: '{ items: string[] }',
		target: '{ items: string[] }',
		expected: /nested-object\/array copying is disabled/,
	},
	{
		name: 'nullable sources cannot fill non-nullable targets',
		source: '{ id: string | null }',
		target: '{ id: string }',
		expected: /not assignable/,
	},
	{
		name: 'optional sources cannot fill required targets',
		source: '{ id?: string }',
		target: '{ id: string }',
		expected: /not assignable/,
	},
	{
		name: 'any source fields cannot bypass type safety',
		source: '{ id: any }',
		target: '{ id: string }',
		expected: /Source 'id' has an unsupported type/,
	},
	{
		name: 'any target fields cannot bypass type safety',
		source: '{ id: string }',
		target: '{ id: any }',
		expected: /Target 'id' has an unsupported type/,
	},
]) {
	test(name, (t) => {
		// Arrange
		const f = fixture(
			t,
			`/** @mapper */
export abstract class Mapper { abstract toDto(source: ${source}): ${target}; }`,
		);

		// Act & Assert
		assert.throws(() => generate(ts, f.project), expected);
	});
}

test('class targets run constructors and retain prototypes, private state and optional defaults', async (t) => {
	// Arrange
	const f = fixture(
		t,
		`
class Base {
  id = '';
  protected prefix = 'User';
  label(): string { return this.prefix + ': ' + this.id; }
}
class User extends Base {
  static constructed = 0;
  note?: string = 'default';
  #secret = 'internal';
  constructor() { super(); User.constructed++; }
  get secret(): string { return this.#secret; }
}
/** @mapper */
export abstract class Mapper {
  abstract toUser(source: { id: string; note?: string; secret: string }): User;
  isUser(value: unknown): boolean { return value instanceof User && value instanceof Base; }
  constructed(): number { return User.constructed; }
}`,
		{ exactOptionalPropertyTypes: true },
	);
	const source = { id: '1', secret: 'must not overwrite internal state' };

	// Act
	const mapper = await execute(f);
	const first = mapper.toUser(source);
	const second = mapper.toUser({ ...source, note: 'provided' });

	// Assert
	assert.equal(mapper.isUser(first), true);
	assert.equal(mapper.constructed(), 2);
	assert.notEqual(first, second);
	assert.equal(first.label(), 'User: 1');
	assert.equal(first.secret, 'internal');
	assert.equal(first.note, 'default');
	assert.equal(second.note, 'provided');
	assert.deepEqual(source, { id: '1', secret: 'must not overwrite internal state' });
});

for (const { name, imported, target } of [
	{
		name: 'named import alias',
		imported: "import { User as Person } from './models.js';",
		target: 'Person',
	},
	{
		name: 'namespace import',
		imported: "import * as models from './models.js';",
		target: 'models.User',
	},
	{ name: 'default import', imported: "import Person from './models.js';", target: 'Person' },
]) {
	test(`constructs an imported class through a ${name}`, async (t) => {
		// Arrange
		const f = fixture(
			t,
			`${imported}
/** @mapper */
export abstract class Mapper {
  /** @map target=name source=label */
  abstract toUser(source: { label: string }): ${target};
  isUser(value: unknown): boolean { return value instanceof ${target}; }
}`,
		);
		writeFileSync(
			join(f.dir, 'models.ts'),
			`export class User {
  name = '';
  constructor(prefix: string = 'Hello') { this.#prefix = prefix; }
  #prefix: string;
  greeting(): string { return this.#prefix + ' ' + this.name; }
}
export default User;`,
		);

		// Act
		const mapper = await execute(f);
		const result = mapper.toUser({ label: 'Ada' });

		// Assert
		assert.equal(mapper.isUser(result), true);
		assert.equal(result.greeting(), 'Hello Ada');
	});
}

for (const { name, declaration, expected } of [
	{
		name: 'required constructor arguments',
		declaration: 'class User { id: string; constructor(id: string) { this.id = id; } }',
		expected: /constructor callable without arguments/,
	},
	{
		name: 'abstract class',
		declaration: 'abstract class User { id = ""; }',
		expected: /concrete classes/,
	},
	{
		name: 'private constructor',
		declaration: 'class User { id = ""; private constructor() {} }',
		expected: /private|constructor callable without arguments/,
	},
	{
		name: 'readonly target field',
		declaration: 'class User { readonly id = ""; }',
		expected: /readonly/,
	},
	{
		name: 'type alias to a class',
		declaration: 'class ActualUser { id = ""; } type User = ActualUser;',
		expected: /not a type alias/,
	},
]) {
	test(`rejects a class target with ${name} instead of returning a plain object`, (t) => {
		// Arrange
		const f = fixture(
			t,
			`${declaration}
/** @mapper */
export abstract class Mapper { abstract toUser(source: { id: string }): User; }`,
		);

		// Act & Assert
		assert.throws(() => generate(ts, f.project), expected);
	});
}

for (const imported of [
	"import type { User } from './models.js';",
	"import { type User } from './models.js';",
]) {
	test(`rejects a type-only class import: ${imported}`, (t) => {
		// Arrange
		const f = fixture(
			t,
			`${imported}
/** @mapper */
export abstract class Mapper { abstract toUser(source: { id: string }): User; }`,
		);
		writeFileSync(join(f.dir, 'models.ts'), 'export class User { id = ""; }');

		// Act & Assert
		assert.throws(() => generate(ts, f.project), /runtime import/);
	});
}

test('ordinary JSDoc can document mapping methods without changing their behavior', async (t) => {
	// Arrange
	const f = fixture(
		t,
		`
interface Row { id: string; sensorName: string; secret: string }
interface Dto { id: string; name: string }
/** @mapper */
export abstract class Mapper {
  /**
   * Converts a database row to its public DTO.
   * @param source the original row
   * @returns the public representation
   * @deprecated Use the newer API.
   * @example mapper.toDto(row)
   * @see Row
   * @remarks Only public fields are included.
   * @throws Error when conversion fails
   * @map target=name source=sensorName
   */
  abstract toDto(source: Row): Dto;
}`,
	);

	// Act
	const mapper = await execute(f);
	const result = mapper.toDto({ id: '1', sensorName: 'Outdoor', secret: 'hidden' });

	// Assert
	assert.deepEqual(result, { id: '1', name: 'Outdoor' });
});

test('custom documentation tags are ignored alongside mapping rules', async (t) => {
	// Arrange
	const f = fixture(
		t,
		`/** @mapper */
export abstract class Mapper {
  /**
   * @customDocumentation owned by another tool
   * @maps ignored because it is not a MapperGen tag
   * @map target=name source=label
   * @convert reading toNumber
   */
  abstract toDto(source: { label: string; reading: string }): { name: string; reading: number };
  protected toNumber(value: string): number { return Number(value); }
}`,
	);

	// Act
	const mapper = await execute(f);
	const result = mapper.toDto({ label: 'Outdoor', reading: '12.5' });

	// Assert
	assert.deepEqual(result, { name: 'Outdoor', reading: 12.5 });
});
