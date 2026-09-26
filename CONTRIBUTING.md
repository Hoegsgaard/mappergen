# Contributing

Bug reports, documentation improvements and focused pull requests are welcome.
For larger features or changes to the public API, open an issue first so we can
agree on the direction before you spend time implementing them.

## Report a bug

Search [existing issues](https://github.com/Hoegsgaard/mappergen/issues) first. Include
the MapperGen and Node.js versions, a minimal mapper with its source and target
types, relevant compiler settings, the complete error message, and what you expected
to happen. Use fictional data and remove secrets from reproductions.

## Set up locally

Use Node.js 22.12+ (22.x), 24.x or 26.x and npm.

1. Fork the repository and clone your fork locally.
2. Create a branch from `main` for your change.
3. From the repository root, install dependencies and check the baseline:

   ```sh
   npm ci
   npm run verify
   ```

`npm ci` builds the library through its `prepare` hook. `npm run verify` checks
formatting, builds the library, compiles and runs the tests, and validates the basic
example. Tests include public type declarations, real Vite integration and an npm
tarball installed in a temporary consumer. Nothing is published by these checks.

## Make a change

- Keep each pull request focused on one problem or improvement.
- Add regression coverage for bug fixes and behavior changes. Test observable
  results and useful error messages, including fields that must not be copied.
  Use explicit Arrange, Act and Assert sections; exception checks can combine
  Act and Assert. Add tests for meaningful behavior, not to meet a coverage target.
- Update the relevant documentation and example when public behavior changes.
  Keep examples fictional and framework-neutral.
- Keep compiler analysis, runtime and adapters separate. Preserve the single
  handwritten mapper API, and add abstractions only for distinct responsibilities.
- Edit source files, not generated output. Do not commit `dist/`, `.test-dist/` or
  `node_modules/`. Include `package-lock.json` when changing dependencies.

Before opening a pull request, run:

```sh
npm run format
npm run verify
```

For targeted work, `npm test` builds and runs the tests; `npm run check` builds and
validates the basic example. `npm run typecheck` checks source and tests without
emitting files. Tests import the built library, so run `npm run build` after source
changes before a standalone typecheck or testing a linked consumer. `npm test`
handles that build order automatically. The installed-package test uses
`npm_execpath` supplied by npm; run it through `npm test` rather than invoking
`node --test` directly.

## Open a pull request

Commit your changes to your branch, push it to your fork, and open a pull request
against `Hoegsgaard/mappergen` on `main`. Describe the problem, what changed and how
you verified it. Link any related issue and call out changes to public behavior or
compatibility.

The maintainer reviews pull requests and decides what to merge and release. Please
respond to review feedback and keep CI checks passing. Contribution pull requests
should not bump the package version or create release tags. Official MapperGen
releases are managed by the project maintainer.

## Find your way around

- `src/generate.ts`: compiler orchestration, type analysis, method generation and
  validation of the transformed program.
- `src/compiler/annotations.ts`: annotation syntax parsing, independent of compiler types.
- `src/runtime.ts`: typed mapper instance lookup; no compiler or framework dependencies.
- `src/vite.ts`: Vite lifecycle, transformation and dependency invalidation.
- `src/cli.ts`: command-line validation.
- `test/`: compiler, diagnostics, runtime, CLI, source map and integration tests.
  `api.types.ts` checks the emitted public declarations during test compilation.
- `examples/basic/`: one mapper and its usage.

`tsconfig.json` provides shared strict rules and the editor project for source and
tests. `tsconfig.build.json` emits the library into `dist/`, including declarations
and maps. `tsconfig.test.json` emits tests into `.test-dist/`. The basic example has
its own configuration.

The package uses ESM entry points defined in `exports`. Published `src/` files are
intentional: declaration maps point to them for editor navigation.
