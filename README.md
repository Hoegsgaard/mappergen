# MapperGen

[![CI](https://github.com/Hoegsgaard/mappergen/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Hoegsgaard/mappergen/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/mappergen)](https://www.npmjs.com/package/mappergen)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Generate type-checked object mappings from TypeScript method signatures.
Write one mapper with explicit exceptions; matching fields are mapped automatically.
No runtime reflection, framework or ORM required.

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

`id` is copied, `sensorName` becomes `name`, and `internalNote` is left out. Add a
target field that cannot be mapped and the build fails.

- **No hand-written assignments.** Matching fields are mapped from the signature;
  annotations cover only the exceptions.
- **Mapping is checked at build time.** Unmapped target fields, incompatible types
  and malformed mapping rules stop the build with a source location.
- **No generated files to manage.** Implementations are produced in memory during the
  build.
- **Your models stay yours.** No MapperGen annotations, base classes or decorators on
  them.
- **Nested objects and lists are checked too**, field by field, when mapped with
  `@delegate`.
- **Plain objects or real class instances**, with constructors and prototypes intact.

MapperGen checks the mapping, not your data. A converter's own logic is yours to get
right — `Number(value)` can still return `NaN` — and a tag it does not recognize,
such as a misspelled `@maps`, is ignored rather than reported.

## Quick start

Requires Node.js `^22.12.0 || ^24.0.0 || ^26.0.0`, Vite 8.x (8.2.1 or later), and
TypeScript with `strict` enabled.

### 1. Install

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
	"extends": "./tsconfig.app.json",
	"include": ["src/mappers/*Mapping.ts"]
}
```

Extend whichever config holds your `compilerOptions`. Several Vite templates leave
`tsconfig.json` as nothing but references to `tsconfig.app.json` and
`tsconfig.node.json`; extending the root file there inherits no options, and
MapperGen stops with `strictNullChecks (or strict) must be enabled`.

The project path is relative to Vite's root. Include your mapper files; their
imported model types are read automatically.

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

### 4. Use it

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

Run your normal Vite development or build command. To check mappings without a
build:

```sh
npx mappergen --project tsconfig.mappers.json --validate
```

## Rules at a glance

| Rule                                         | Behavior                                                             |
| -------------------------------------------- | -------------------------------------------------------------------- |
| Same field name                              | Copy compatible scalar values automatically.                         |
| Null/undefined mismatch                      | Bridge it automatically when the underlying types match.             |
| Array of scalars                             | Copy into a new array automatically.                                 |
| `@map target=targetField source=sourceField` | Rename a source field.                                               |
| `@convert targetField converterMethod`       | Pass the source value to a handwritten method on the contract.       |
| `@delegate targetField mappingMethod`        | Map a nested object or array of objects with another mapping method. |
| `@delegate targetField Contract.method`      | Same, for a contract elsewhere in the project. No import needed.     |
| `@delegate mappingMethod`                    | On a list mapping method: map every element with that method.        |
| Source-only field                            | Exclude it from the result.                                          |

## Nested objects and lists

`@delegate` maps a field with another mapping method, so the nested mapping is
generated and checked field by field too, rather than copied by reference. Say
`SensorRow` also has a `placement` object and a list of `observers`:

```ts
/** @mapper */
export abstract class SensorMapping {
	/**
	 * @delegate placement toPlacement
	 * @delegate observers UserMapping.toDto
	 */
	abstract toDto(source: SensorRow): SensorDto;

	/** @delegate toDto */
	abstract toDtos(source: readonly SensorRow[]): SensorDto[];

	abstract toPlacement(source: PlacementRow): PlacementDto;
}
```

`placement` is mapped by a method on the same contract. `observers` is an array
mapped by a method on _another_ contract — no import needed — so that method runs for
each element. Add a field to `PlacementDto` that cannot be mapped and the build
fails, instead of quietly producing `undefined`.

`toDtos` has an array on both sides, which makes it a list mapping method: it maps a
whole list the way a database query hands it to you, and `@delegate` names the method
that maps one element.

See the [mapping rules reference](https://github.com/Hoegsgaard/mappergen/blob/main/docs/mapping-rules.md)
for recursion, nullable elements, `null`/`undefined` handling and class targets.

## What MapperGen does not do

Some of these are deliberate design choices:

- **Nested objects require explicit delegation.** A nested object or an array of
  objects needs `@delegate`, so the nested mapping is generated and checked field by
  field rather than copied by reference.
- **Contracts, sources and targets have to be concrete.** A mapper contract is a
  declaration rather than a base class, a whole source or target must be an object
  shape or an array, and a target class is constructed without arguments. The
  [reference](https://github.com/Hoegsgaard/mappergen/blob/main/docs/mapping-rules.md)
  has the exact rules.

Others are simply not supported yet, and may change:

- `Set` and `Map`.
- Tuples such as `[string, number]`, as fields or as the whole source or target.
- Ignore rules, to leave a target field unmapped on purpose.
- TypeScript project references.

Both lists are enforced by the build, so you will hear about it rather than get a
silently wrong result. For a workaround today, `@convert` is the escape hatch:
MapperGen checks the converter's types but does not look inside it.

## Documentation

- [Mapping rules reference](https://github.com/Hoegsgaard/mappergen/blob/main/docs/mapping-rules.md) — every rule, with nested objects, lists, nullability and class targets.
- [Troubleshooting](https://github.com/Hoegsgaard/mappergen/blob/main/docs/troubleshooting.md) — build errors and what to change.
- [Build integration](https://github.com/Hoegsgaard/mappergen/blob/main/docs/build-integration.md) — entry points, Vitest, plugin order, supported Node and TypeScript versions.

## Examples

The [basic mapper](https://github.com/Hoegsgaard/mappergen/blob/main/examples/basic/SensorMapping.ts),
the [contract it delegates to](https://github.com/Hoegsgaard/mappergen/blob/main/examples/basic/UserMapping.ts)
and their [usage](https://github.com/Hoegsgaard/mappergen/blob/main/examples/basic/main.ts)
cover automatic null bridging, arrays, a class target, a list mapping method and
delegation within and across contracts. In a repository checkout, run `npm ci`
followed by `npm run check` to validate them.

## Contributing

See [CONTRIBUTING.md](https://github.com/Hoegsgaard/mappergen/blob/main/CONTRIBUTING.md)
for local development, tests and pull requests.

## License

[MIT](LICENSE) © 2026 Mathias Høgsgaard.
