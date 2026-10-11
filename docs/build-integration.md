# Build integration

How MapperGen plugs into a build beyond the [README](../README.md) setup.

## Entry points

| Import               | Use                                                               |
| -------------------- | ----------------------------------------------------------------- |
| `mappergen`          | `getMapper` in application code.                                  |
| `mappergen/vite`     | `mapperGen` in build configuration.                               |
| `mappergen/compiler` | `generate` and `generateWithMaps`, for custom build integrations. |

Importing the main package does not load the compiler or Vite.

Vite and Vitest are the supported integration. Running a handwritten mapper
directly with Node or tsx does not generate implementations. Other build systems
need an adapter around the compiler API.

## Vitest

Vitest reads `vite.config.ts` unless a separate `vitest.config.ts` overrides it. If
you use a separate configuration, add `mapperGen()` there too, or merge it with your
Vite configuration.

## Plugin order

Place `mapperGen()` before other `enforce: 'pre'` plugins that transform mapper
files. Generation analyzes source files on disk; it rejects an earlier
transformation rather than overwriting it. Plugins that run afterwards receive the
generated code.

The plugin validates transformed code before building, and regenerates mappings when
local models or contracts change. Restart the development server after changing
compiler settings or installed dependencies. For SSR, the plugin bundles the small
runtime helper; the compiler is not needed to execute that bundle.

## TypeScript versions

Analysis uses `@typescript/typescript6` (6.0.x), independently of the application's
own compiler. Mapper files and imported models must be readable by that compiler,
even when the application uses TypeScript 7. TypeScript 7's unstable API is not
used; see [Microsoft's compatibility guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).

TypeScript project references are not supported.

## Platforms

Node.js 22.12+ (22.x), 24.x and 26.x are supported. CI verifies the minimum and
latest version of each line on Linux, and Node 24 on Windows and macOS. Other
combinations of a supported Node line and platform are expected to work; please
[report](https://github.com/Hoegsgaard/mappergen/issues) any that do not.
