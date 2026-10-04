# MapperGen

[![CI](https://github.com/Hoegsgaard/mappergen/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Hoegsgaard/mappergen/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/mappergen)](https://www.npmjs.com/package/mappergen)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Generate type-checked object mappings from TypeScript method signatures.
Write one mapper with explicit exceptions; matching fields are mapped automatically.
No runtime reflection, framework or ORM required.

- [Why MapperGen?](#why-mappergen)
- [Quick start](#quick-start)
- [Mapping rules](#mapping-rules)
- [Class instances](#class-instances)
- [Build and tests](#build-and-tests)
- [Compatibility and limitations](#compatibility-and-limitations)
- [Troubleshooting and debugging](#troubleshooting-and-debugging)
- [Examples and contributing](#examples-and-contributing)

## Why MapperGen?

Mapping between database records, API models and DTOs often means writing the same
field assignments repeatedly. When a model changes, those assignments need to stay
in sync.

MapperGen uses your method signatures to generate those assignments during the
build. Matching fields are mapped automatically; annotations describe renames and
conversion methods handle differences in representation.

```ts
interface SensorRow {
	id: string;
	sensorName: string;
	internalNote: string;
}
interface SensorDto {
	id: string;
	name: string;
}

/** @mapper */
export abstract class SensorMapping {
	/** @map target=name source=sensorName */
	abstract toDto(source: SensorRow): SensorDto;
}
```

Here, `id` is copied, `sensorName` becomes `name`, and `internalNote` is left out.
Adding a target field that cannot be mapped produces a build error. You maintain
one mapper file; its implementation is generated in memory, with no generated
source files to manage. Models need no MapperGen annotations or base classes.

## Quick start

Requires Node.js `^22.12.0 || ^24.0.0 || ^26.0.0`, TypeScript with `strict` enabled,
and Vite for build integration.

### 1. Install

In your Vite application:

```sh
npm install --save-dev mappergen
```

### 2. Configure the build

Enable the plugin in `vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import { mapperGen } from 'mappergen/vite';

export default defineConfig({
	plugins: [mapperGen({ project: 'tsconfig.mappers.json' })],
});
```

Create `tsconfig.mappers.json`:

```json
{
	"extends": "./tsconfig.json",
	"include": ["src/mappers/*Mapping.ts"]
}
```

The project path is relative to Vite's root. Include mapper files; their imported
model types are read automatically.

### 3. Write a mapper

Create `src/mappers/SensorMapping.ts`:

```ts
import { getMapper } from 'mappergen';

interface SensorRow {
	id: string;
	sensorName: string;
	reading: string;
	internalNote: string;
}
export class SensorDto {
	id!: string;
	name!: string;
	reading!: number;
}

/** @mapper */
export abstract class SensorMapping {
	/**
	 * @map target=name source=sensorName
	 * @convert reading toNumber
	 */
	abstract toDto(source: SensorRow): SensorDto;

	protected toNumber(value: string): number {
		return Number(value);
	}
}

export const sensorMapping = getMapper(SensorMapping);
```

### 4. Use the mapper

Import and call it from your application:

```ts
import { SensorDto, sensorMapping } from './mappers/SensorMapping.js';

const dto = sensorMapping.toDto({
	id: 'sensor-1',
	sensorName: 'Outdoor',
	reading: '21.5',
	internalNote: 'Private',
});
// SensorDto { id: 'sensor-1', name: 'Outdoor', reading: 21.5 }
console.log(dto instanceof SensorDto); // true
```

Run your normal Vite development or build command. Methods are generated in memory;
only target fields are copied. Missing fields, incompatible types and invalid annotations fail the build.
Method calls are type-checked by TypeScript; annotation field names are checked by
MapperGen, and do not have editor autocomplete or rename support.

## Mapping rules

Mark a named, exported abstract class with `@mapper`. Each abstract mapping method
must be public, have one required explicitly typed input parameter and an explicit
object return type. `getMapper(Contract)` returns a typed, cached instance after
build transformation; calling it without transformation fails immediately.

| Rule                                 | Behavior                                                              |
| ------------------------------------ | --------------------------------------------------------------------- |
| Same field name                      | Copy compatible scalar values automatically.                          |
| Null/undefined mismatch              | Bridge it automatically when the underlying types match.              |
| `@map target=name source=sensorName` | Rename a source field. Named arguments may appear in either order.    |
| `@convert reading toNumber`          | Pass the source value to a concrete public/protected instance method. |
| `@delegate placement toPlacement`    | Map the field with another abstract mapping method on the contract.   |
| `@delegate owner Contract.method`    | Same, but the method lives on another `@mapper` contract.             |
| `@map` with either                   | Rename first, then convert or delegate the selected source value.     |
| Source-only field                    | Exclude it from the result.                                           |

MapperGen processes only `@map`, `@convert` and `@delegate` on mapping methods. Other
tags, including JSDoc and custom documentation tags, are ignored. Misspelled tag names
such as `@maps` are therefore ignored too; recognized mapping rules still have
their syntax, field names and converter types validated.

Converters live on the mapper class. Their input and output types are validated.
An unknown field, missing converter, duplicate rule or incompatible type fails the
build with a source location. Field names in comments are not editor-aware. A field
takes `@convert` or `@delegate`, never both.

Only target fields are copied. Inherited data fields are supported. Primitive values,
compatible unions of scalar types and built-in Date values can be copied directly.
Dates remain the same object reference.

### Nested objects

A nested object field is mapped by `@delegate`, which points at another abstract mapping
method — on this contract, or on another one in the project. The simplest form names a
method on the same contract:

```ts
/** @mapper */
export abstract class SensorMapping {
	/** @delegate placement toPlacement */
	abstract toDto(source: SensorRow): SensorDto;

	abstract toPlacement(source: PlacementRow): PlacementDto;
}
```

The nested mapping is generated and checked field by field, exactly like the outer one,
so adding a field to `PlacementDto` fails the build instead of silently producing
`undefined`. That is the difference from `@convert`: a handwritten converter is an escape
hatch that MapperGen does not look inside.

The delegate may be declared in any order relative to its caller, may serve several
fields, and may be the mapping method itself for recursive structures. A delegation cycle
must pass through an optional or nullable field, or it recurses forever.

A delegate on **another contract** is named `Contract.method`, so a mapper you already use
on its own can be reused instead of duplicated:

```ts
import { UserMapping } from './UserMapping.js';

/** @mapper */
export abstract class SensorMapping {
	/** @delegate owner UserMapping.toDto */
	abstract toDto(source: SensorRow): SensorDto;
}
```

The named contract must be in scope, carry `@mapper`, be part of the same mapping project
— otherwise it is never generated — and be imported at runtime rather than with
`import type`. MapperGen calls it through its cached `getMapper` instance, so it behaves
exactly as it does for its own callers.

One wrinkle: TypeScript does not resolve names inside a JSDoc tag, so under
`noUnusedLocals` your own `tsc` and editor report the import as unused even though the
generated code needs it. The generated output itself stays clean. Use the contract
somewhere in the file — `export const users = getMapper(UserMapping);` is usually
wanted anyway — or silence it for that import.

A delegate's parameter cannot be nullable — a mapping method's source must be a concrete
object shape — so MapperGen bridges the empty case at the call site: `null`, `undefined`
and absent values never reach the delegate, and the target decides what appears instead,
following the table under [Null and undefined](#null-and-undefined). One difference from a
direct copy: a delegated optional target is omitted even when it also allows `null`.

Arrays still need a converter. It can call a delegated mapping method with `.map()`, which
keeps the guarantee, because the wrapper itself contains no field assignments.

### Null and undefined

When the underlying types match, MapperGen bridges `null`/`undefined` differences
itself; no converter is needed for a field that only changes how it spells "no value".
A `string | null` source fills a `string | undefined` target, and an optional source
fills a `string | null` target. The target type decides the result:

| Target field                | Result for a missing source value                                     |
| --------------------------- | --------------------------------------------------------------------- |
| `note?: string`             | Omitted from the result.                                              |
| `note: string \| undefined` | `undefined`.                                                          |
| `note: string \| null`      | `null`.                                                               |
| `note?: string \| null`     | `null` stays `null`; only an absent or `undefined` source is omitted. |

Optional targets are omitted rather than assigned `undefined`, so the result is the
same with and without `exactOptionalPropertyTypes`. Falsy values are preserved:
`0`, `''`, `false` and `0n` are values, not absence.

A target that allows neither `null`, `undefined` nor absence still fails the build —
`string | null` into `string` has nowhere to put the missing case. Bridging also never
weakens type checking: `number | null` into `string | undefined` still fails.

`@convert` disables bridging for that field and assigns the converter's result as-is.
Use it when you want an optional target set to `undefined` rather than omitted. A
handwritten converter receives the source value exactly as declared, nullable or not.
`@delegate` is the opposite: bridging stays on, because a generated mapping method
cannot accept `null` or `undefined`.

Optional target fields still require a source. When both fields are optional and
there is no converter, an absent source field is omitted from the result.

## Class instances

Interface and object-literal targets produce plain objects. Class targets produce
real instances: MapperGen calls `new Target()` and then assigns the mapped public
data fields. Constructors, field initializers and inherited behavior run normally;
methods, accessors and private/protected state are retained, not copied from the source.

Imported class targets must use a regular runtime import, not `import type`. Named aliases,
default imports and namespace imports are supported. Use the class reference
itself as the return type, rather than a type alias to the class.

Class targets must be concrete and have a public constructor callable without
arguments. Optional/default constructor parameters are allowed. Public data fields
must be writable and still need source fields, even when initialized or optional.
When no converter is used and the source value is absent — or is a `null`/`undefined`
the field cannot hold — the matching optional target field retains the constructor's
default rather than being overwritten. A real value is assigned normally, as is an
`undefined` whose target type explicitly allows it.

Constructor arguments, factories and assignment to readonly fields or accessors
are unsupported. Constructors run before field assignment; they cannot validate
mapped values at construction time. Class methods/getters remain available after
mapping, but do not run automatically to validate the result.

The `!` in `id!: string` declares that the field will be assigned after construction;
MapperGen performs that assignment. Artificial default values are not required.

## Build and tests

Use `getMapper` from `mappergen` in application code and `mapperGen` from
`mappergen/vite` in build configuration. The advanced compiler API
(`generate`, `generateWithMaps`) is available from `mappergen/compiler` for custom
build integrations. Importing the main package does not load the compiler or Vite.

Vite/Vitest is the supported build integration. Direct execution of handwritten
mappers with Node or tsx does not generate implementations. Other build systems
need an adapter around the compiler API.

Vitest reads `vite.config.ts` unless a separate `vitest.config.ts` overrides it.
If you use a separate configuration, add `mapperGen()` there too or merge it with
your Vite configuration.

The plugin validates transformed code before building and regenerates mappings
when local models or contracts change. Restart the development server after
changing compiler settings or installed dependencies. For SSR, the plugin bundles
the small runtime helper; the compiler is not needed to execute that bundle.

To validate mappings without a build:

```sh
npx mappergen --project tsconfig.mappers.json --validate
```

Run this before your normal `tsc --noEmit` check. TypeScript alone sees the abstract
contracts; it does not generate or validate the missing method implementations.
Validation happens in memory and writes no source files.

## Compatibility and limitations

Node.js 22.12+ (22.x), 24.x and 26.x are supported. CI verifies the minimum and
latest version of each line on Linux, and Node 24 on Windows and macOS. Other
combinations of a supported Node line and platform are expected to work; please
report any that do not.

Analysis uses `@typescript/typescript6` (6.0.x), independently of the application's
compiler. Mapper files and imported models must be readable by that compiler, even
when the application uses TypeScript 7. TypeScript 7's unstable API is not used;
see [Microsoft's compatibility guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).

Place `mapperGen()` before other `enforce: 'pre'` plugins that transform mapper
files. Generation analyzes source files on disk; it rejects earlier transformations
instead of overwriting them. Plugins that run afterwards receive the generated code.

Unsupported features:

- Generic mapper contracts, mapper inheritance, constructors or instance fields
  on the mapper itself. Target classes can have constructors and inheritance as
  described [above](#class-instances).
- Union, array, tuple, index-signature or callable types as the entire source/target.
  Scalar unions such as `string | null` are supported as fields, and null/undefined
  mismatches between source and target are bridged automatically; nested object fields
  require `@delegate`, and array fields require a converter.
- _Implicit_ nested-object mapping — delegation must be requested with `@delegate` —
  plus ignore rules, factories and async mapping.
- TypeScript project references.

## Troubleshooting and debugging

- **“has not been generated”**: use the Vite/Vitest plugin and check that the mapper
  file is included in the mapping project.
- **Unmapped target field**: provide a same-name source field or an explicit `@map`.
  Optional targets still need a source.
- **Incompatible field type**: the underlying types differ — add a typed conversion
  method and `@convert`.
- **Target has nowhere to put a missing value**: the source allows `null`/`undefined`
  but the target does not. Make the target optional or add `| null`/`| undefined`,
  or add a converter that supplies a fallback.
- **Needs an explicit rule**: the field is a nested object or array. Add `@delegate` to
  map it with another mapping method, or `@convert` for a handwritten conversion.
- **Delegate is a concrete method / Converter is an abstract mapping method**: the two
  tags are swapped. `@delegate` names an abstract mapping method; `@convert` names a
  handwritten one.
- **Delegate qualifier is not an `@mapper` contract in scope / is not part of the mapping
  project**: `@delegate field Contract.method` needs `Contract` imported at runtime, marked
  `@mapper`, and included by the mapping project so that it is generated too.
- **Class target needs a runtime import**: replace `import type` with a regular
  import of the target class.
- A contract reports one error at a time. Because delegation couples mapping methods,
  fixing a nested mapping can reveal the next error in its caller, or the other way round.

Source maps preserve handwritten converter locations. Generated method bodies map
back to their abstract declarations. Enable source maps in production builds and
use Node's `--enable-source-maps` to resolve those locations in stack traces.

## Examples and contributing

The [basic mapper](https://github.com/Hoegsgaard/mappergen/blob/main/examples/basic/SensorMapping.ts),
the [contract it delegates to](https://github.com/Hoegsgaard/mappergen/blob/main/examples/basic/UserMapping.ts)
and their [usage](https://github.com/Hoegsgaard/mappergen/blob/main/examples/basic/main.ts)
include automatic null lifting, a class target and delegation within and across
contracts. In a repository checkout, run `npm ci` followed by `npm run check` to
validate the example.

See [CONTRIBUTING.md](https://github.com/Hoegsgaard/mappergen/blob/main/CONTRIBUTING.md)
for local development, tests and pull requests.

## License

[MIT](LICENSE) © 2026 Mathias Høgsgaard.
