# Troubleshooting

Build errors MapperGen reports, and what to change. Every error carries the source
location of the contract, method or annotation that caused it.

| Error                                                                           | What to do                                                                                                                                                                                           |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **“has not been generated”**                                                    | Use the Vite/Vitest plugin, and check that the mapper file is included in the mapping project.                                                                                                       |
| **Unmapped target field**                                                       | Provide a same-name source field or an explicit `@map`. Optional targets still need a source.                                                                                                        |
| **Incompatible field type**                                                     | The underlying types differ. Add a typed conversion method and `@convert`.                                                                                                                           |
| **Target has nowhere to put a missing value**                                   | The source allows `null`/`undefined` but the target does not. Make the target optional, add `\| null`/`\| undefined`, or add a converter that supplies a fallback.                                   |
| **Needs an explicit rule**                                                      | The field is a nested object, an array of objects, or a collection MapperGen does not copy. Add `@delegate` to map it with another mapping method, or `@convert` for a handwritten conversion.       |
| **Must have an array source and an array target**                               | Only one side of the mapping method is an array. A list maps to a list; wrap it in an object to map it to one.                                                                                       |
| **Cannot accept field … or its elements**                                       | The delegate matches neither the whole field nor one element of it. Check whether it takes `T` or `T[]`.                                                                                             |
| **Delegate is a concrete method** / **Converter is an abstract mapping method** | The two tags are swapped. `@delegate` names an abstract mapping method; `@convert` names a handwritten one.                                                                                          |
| **Delegate qualifier is not an `@mapper` contract** / **names more than one**   | `Contract` in `@delegate targetField Contract.mappingMethod` must carry `@mapper`, be included by the mapping project so it is generated too, and be unique there. Rename or import to disambiguate. |
| **Class target needs a runtime import**                                         | Replace `import type` with a regular import of the target class.                                                                                                                                     |
| **TS6133 on a contract import**                                                 | The import is unused because the annotation resolves the name on its own. Delete the import.                                                                                                         |

A contract reports one error at a time. Because delegation couples mapping methods,
fixing a nested mapping can reveal the next error in its caller, or the other way
round.

## Debugging generated code

Source maps preserve handwritten converter locations, and generated method bodies
map back to their abstract declarations. Enable source maps in production builds and
use Node's `--enable-source-maps` to resolve those locations in stack traces.

To check mappings without running a build:

```sh
npx mappergen --project tsconfig.mappers.json --validate
```

Run this before your normal `tsc --noEmit` check. TypeScript alone sees the abstract
contracts; it does not generate or validate the missing method implementations.
Validation happens in memory and writes no source files.
