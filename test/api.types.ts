import { generate, type GenerateOptions } from 'mappergen/compiler';
import { getMapper, type MapperContract } from 'mappergen';
import { mapperGen, type MapperGenOptions } from 'mappergen/vite';
import ts from '@typescript/typescript6';
import type { Plugin } from 'vite';

// Compile-only tests of the declarations consumers receive, including inference and rejection.
export function checkPublicTypes(
	contract: MapperContract<{ toDto(source: { id: string }): { id: string } }>,
): void {
	// Arrange
	const instance = getMapper(contract);

	// Act & Assert: assignments must compile; invalid calls must remain type errors.
	const id: string = instance.toDto({ id: '1' }).id;
	void id;
	// @ts-expect-error Source fields must match the mapper signature.
	instance.toDto({ id: 123 });
	// @ts-expect-error Unknown mapping methods are not accepted.
	instance.nonexistent();

	// Vite adapter options
	const options: MapperGenOptions = { project: 'tsconfig.json' };
	const plugin: Plugin = mapperGen(options);
	void plugin;
	// @ts-expect-error Unknown plugin options are not accepted.
	mapperGen({ projectFile: 'tsconfig.json' });

	// Compiler API and dependency callback
	const compilerOptions: GenerateOptions = {
		onDependencies(files) {
			files.map((file) => file.toUpperCase());
		},
	};
	const modules: Map<string, string> = generate(ts, 'tsconfig.json', compilerOptions);
	void modules;
}
