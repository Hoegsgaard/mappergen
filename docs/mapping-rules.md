# Mapping rules reference

Complete reference for what MapperGen maps and how. For installation and a first
mapper, start with the [README](../README.md).

- [The contract](#the-contract)
- [Rules](#rules)
- [Nested objects](#nested-objects)
- [Lists and arrays](#lists-and-arrays)
- [Null and undefined](#null-and-undefined)
- [Class instances](#class-instances)

## The contract

Mark a named, exported abstract class with `@mapper`. Each abstract mapping method
must be public, have one required explicitly typed input parameter and an explicit
return type. `getMapper(Contract)` returns a typed, cached instance after build
transformation; calling it without transformation fails immediately.

The contract itself cannot be generic, extend another class, or declare a
constructor or instance fields. Converters are concrete methods on it.

A method's source and target must each be a concrete object shape, or an array on
both sides for a [list mapping method](#lists-and-arrays). A union, tuple, index
signature or call signature as the _whole_ source or target is rejected, and so is an
empty target. Those types remain usable inside the shape: a scalar union such as
`string | null` is an ordinary field, and anything MapperGen will not copy can still
go through `@convert`.

## Rules

| Rule                                           | Behavior                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| Same field name                                | Copy compatible scalar values automatically.                          |
| Null/undefined mismatch                        | Bridge it automatically when the underlying types match.              |
| Array of scalars                               | Copy into a new array automatically.                                  |
| `@map target=targetField source=sourceField`   | Rename a source field. Named arguments may appear in either order.    |
| `@convert targetField converterMethod`         | Pass the source value to a concrete public/protected instance method. |
| `@delegate targetField mappingMethod`          | Map the field with another abstract mapping method on the contract.   |
| `@delegate targetField Contract.mappingMethod` | Same, for a contract elsewhere in the project. No import needed.      |
| `@delegate mappingMethod`                      | On a list mapping method: map every element with that method.         |
| `@map` with either                             | Rename first, then convert or delegate the selected source value.     |
| Source-only field                              | Exclude it from the result.                                           |

Only target fields are copied. Inherited data fields are supported. Primitive
values, compatible unions of scalar types and built-in `Date` values can be copied
directly, as can arrays of them. Dates remain the same object reference; an array
does not — it is copied, so the target never shares the source's list.

MapperGen processes only `@map`, `@convert` and `@delegate` on mapping methods.
Other tags, including JSDoc and custom documentation tags, are ignored. Misspelled
tag names such as `@maps` are therefore ignored too; recognized mapping rules still
have their syntax, field names and converter types validated.

Converters live on the mapper class and their input and output types are validated.
An unknown field, missing converter, duplicate rule or incompatible type fails the
build with a source location. A field takes `@convert` or `@delegate`, never both.
Field names inside annotations are checked by MapperGen rather than by TypeScript,
so they have no editor autocomplete or rename support.

## Nested objects

A nested object field is mapped by `@delegate`, which points at another abstract
mapping method — on this contract, or on another one in the project. The simplest
form names a method on the same contract:

```ts
/** @mapper */
export abstract class SensorMapping {
	/** @delegate placement toPlacement */
	abstract toDto(source: SensorRow): SensorDto;

	abstract toPlacement(source: PlacementRow): PlacementDto;
}
```

The nested mapping is generated and checked field by field, exactly like the outer
one, so adding a field to `PlacementDto` that cannot be mapped fails the build
instead of silently producing `undefined`. That is the difference from `@convert`: a handwritten
converter is an escape hatch that MapperGen does not look inside.

The delegate may be declared in any order relative to its caller, may serve several
fields, and may be the mapping method itself for recursive structures. A delegation
cycle is allowed, and ends where the data does: an absent optional field, a `null`,
or an empty array. The types cannot promise that, though — data that genuinely
contains a cycle recurses until the stack runs out.

A delegate on **another contract** is named `Contract.method`, so a mapper you
already use on its own can be reused instead of duplicated:

```ts
/** @mapper */
export abstract class SensorMapping {
	/** @delegate owner UserMapping.toDto */
	abstract toDto(source: SensorRow): SensorDto;
}
```

No import of `UserMapping` is needed. The name is resolved in the file's scope, then
against the project's `@mapper` contracts — where it must be unambiguous — and the
generated code imports the contract itself, calling it through its cached
`getMapper` instance. It still has to carry `@mapper` and belong to the mapping
project, or it is never generated.

A delegate's parameter cannot be nullable, so MapperGen bridges the empty case at
the call site: `null`, `undefined` and absent values never reach the delegate, and
the target decides what appears instead, following the table under
[Null and undefined](#null-and-undefined). One difference from a direct copy: a
delegated optional target is omitted even when it also allows `null`.

## Lists and arrays

An array of scalars is copied without a rule. The result is always a new array, so
the target never shares the source's list:

```ts
abstract toDto(source: { tags: string[] }): { tags: string[] };
```

An array of objects takes `@delegate`, exactly like a single nested object. The
delegate maps one element and MapperGen generates the loop:

```ts
/** @mapper */
export abstract class SensorMapping {
	/** @delegate observers UserMapping.toDto */
	abstract toDto(source: SensorRow): SensorDto;
}
```

A mapping method whose source and target are both arrays is a **list mapping
method**. It has no fields of its own, so `@delegate` names only the element
mapping method — useful at a service boundary, where a query returns a list:

```ts
/** @mapper */
export abstract class UserMapping {
	abstract toDto(source: UserRow): UserDto;

	/** @delegate toDto */
	abstract toDtos(source: readonly UserRow[]): UserDto[];
}
```

Both sides must be arrays; a list source with an object target, or the other way
round, is an error. `readonly T[]` and `ReadonlyArray<T>` work on either side. A
list mapping method is an ordinary mapping method, so a field may delegate to one —
`@delegate observers toDtos` calls it directly instead of mapping element by
element.

A tuple is not an array here. Copying `[string, number]` with a spread would produce
`(string | number)[]`, which no longer fits the tuple, so a tuple field reports
_needs an explicit rule_ and a tuple as the whole source or target is rejected as not
being a concrete shape. Use `@convert` for one until tuples are supported.

A whole array that may be `null` or `undefined` follows the same rules as any other
field, under [Null and undefined](#null-and-undefined). An element that may be
empty is decided by the **target element** instead, since an element cannot be
omitted:

| Source element    | Target element        | Result                           |
| ----------------- | --------------------- | -------------------------------- |
| `string \| null`  | `string \| null`      | Copied as it is.                 |
| `string \| null`  | `string \| undefined` | `undefined`.                     |
| `UserRow \| null` | `UserDto \| null`     | `null`; the delegate is skipped. |
| `UserRow \| null` | `UserDto`             | Build error: nowhere to put it.  |

## Null and undefined

When the underlying types match, MapperGen bridges `null`/`undefined` differences
itself; no converter is needed for a field that only changes how it spells "no
value". A `string | null` source fills a `string | undefined` target, and an
optional source fills a `string | null` target. The target type decides the result:

| Target field                 | Result for a missing source value                                     |
| ---------------------------- | --------------------------------------------------------------------- |
| `field?: string`             | Omitted from the result.                                              |
| `field: string \| undefined` | `undefined`.                                                          |
| `field: string \| null`      | `null`.                                                               |
| `field?: string \| null`     | `null` stays `null`; only an absent or `undefined` source is omitted. |

Optional targets are omitted rather than assigned `undefined`, so the result is the
same with and without `exactOptionalPropertyTypes`. Falsy values are preserved:
`0`, `''`, `false` and `0n` are values, not absence.

A target that allows neither `null`, `undefined` nor absence still fails the build —
`string | null` into `string` has nowhere to put the missing case. Bridging also
never weakens type checking: `number | null` into `string | undefined` still fails.

`@convert` disables bridging for that field and assigns the converter's result
as-is. Use it when you want an optional target set to `undefined` rather than
omitted. A handwritten converter receives the source value exactly as declared,
nullable or not. `@delegate` is the opposite: bridging stays on, because a generated
mapping method cannot accept `null` or `undefined`.

Optional target fields still require a source. When both fields are optional and
there is no converter, an absent source field is omitted from the result.

## Class instances

Interface and object-literal targets produce plain objects. Class targets produce
real instances: MapperGen calls `new Target()` and then assigns the mapped public
data fields. Constructors, field initializers and inherited behavior run normally;
methods, accessors and private/protected state are retained, not copied from the
source.

Imported class targets must use a regular runtime import, not `import type`. Named
aliases, default imports and namespace imports are supported. Use the class
reference itself as the return type, rather than a type alias to the class.

Class targets must be concrete and have a public constructor callable without
arguments. Optional and default constructor parameters are allowed. Public data
fields must be writable and still need source fields, even when initialized or
optional. When no converter is used and the source value is absent — or is a
`null`/`undefined` the field cannot hold — the matching optional target field
retains the constructor's default rather than being overwritten. A real value is
assigned normally, as is an `undefined` whose target type explicitly allows it.

Constructor arguments and assignment to readonly fields or accessors are not
supported. Constructors run before field assignment, so they cannot validate mapped
values at construction time. Class methods and getters remain available after
mapping, but do not run automatically to validate the result.

The `!` in `id!: string` declares that the field will be assigned after
construction; MapperGen performs that assignment. Artificial default values are not
required.
