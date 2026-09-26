import { dirname, resolve } from 'node:path';

import type TypeScript from '@typescript/typescript6';
import MagicString, { type SourceMap } from 'magic-string';

import { parseFieldRule } from './compiler/annotations.js';

export interface GenerateOptions {
	onDependencies?: (files: readonly string[]) => void;
}

interface SourceEdit {
	start: number;
	end: number;
	text: string;
}

interface FieldRule {
	map?: string;
	convert?: string;
}

export interface GeneratedMapper {
	code: string;
	map: SourceMap;
}

/** Generate mapper implementations without source maps. */
export function generate(
	ts: typeof TypeScript,
	project: string,
	options: GenerateOptions = {},
): Map<string, string> {
	return new Map(
		[...generateWithMaps(ts, project, options)].map(([file, output]) => [file, output.code]),
	);
}

/** Analyze and typecheck mapping implementations with maps back to handwritten contracts. */
export function generateWithMaps(
	ts: typeof TypeScript,
	project: string,
	{ onDependencies }: GenerateOptions = {},
): Map<string, GeneratedMapper> {
	if (
		ts.versionMajorMinor !== '6.0' ||
		!/^6\.0\.\d+$/.test(ts.version) ||
		Number(ts.version.split('.')[2]) < 2 ||
		typeof ts.createProgram !== 'function'
	) {
		throw new Error(
			`MapperGen requires TypeScript >=6.0.2 <6.1.0 Compiler API; received ${ts.version ?? 'unknown'}.`,
		);
	}

	const format = (diagnostics: readonly TypeScript.Diagnostic[]): string =>
		ts.formatDiagnosticsWithColorAndContext(diagnostics, {
			getCanonicalFileName: (f) => f,
			getCurrentDirectory: () => process.cwd(),
			getNewLine: () => '\n',
		});

	const config = ts.readConfigFile(project, ts.sys.readFile);
	if (config.error) throw new Error(format([config.error]));

	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(project));
	if (parsed.errors.length) throw new Error(format(parsed.errors));
	if (!(parsed.options.strictNullChecks ?? parsed.options.strict)) {
		throw new Error('strictNullChecks (or strict) must be enabled.');
	}
	if (parsed.projectReferences?.length) throw new Error('Project references are not supported.');

	const roots = parsed.fileNames;
	const program = ts.createProgram(roots, parsed.options);
	onDependencies?.(program.getSourceFiles().map((file) => file.fileName));

	const checker = program.getTypeChecker();
	const outputs = new Map<string, string>();
	const mapped = new Map<string, GeneratedMapper>();
	const errors: string[] = [];
	const edits = new Map<string, SourceEdit[]>();

	function fail(node: TypeScript.Node, message: string): never {
		const file = node.getSourceFile();
		const pos = file.getLineAndCharacterOfPosition(node.getStart());
		throw new Error(`${file.fileName}:${pos.line + 1}:${pos.character + 1}: ${message}`);
	}

	const hasModifier = (node: TypeScript.Node, kind: TypeScript.ModifierSyntaxKind): boolean =>
		ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false);

	const tags = (node: TypeScript.Node) => ts.getJSDocTags(node);
	const text = (tag: TypeScript.JSDocTag): string =>
		typeof tag.comment === 'string' ? tag.comment.trim() : '';

	function getSymbolType(symbol: TypeScript.Symbol | undefined): TypeScript.Type {
		const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
		if (!symbol || !declaration)
			throw new Error('Unable to resolve a symbol declaration for mapping.');
		return checker.getTypeOfSymbolAtLocation(symbol, declaration);
	}

	const isUnsupportedType = (type: TypeScript.Type): boolean =>
		Boolean(
			type.flags &
			(ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.TypeParameter),
		);

	const canCopyDirectly = (type: TypeScript.Type): boolean => {
		if (type.isUnion()) return type.types.every(canCopyDirectly);
		if (isUnsupportedType(type)) return false;
		if (
			type.flags &
			(ts.TypeFlags.StringLike |
				ts.TypeFlags.NumberLike |
				ts.TypeFlags.BooleanLike |
				ts.TypeFlags.BigIntLike |
				ts.TypeFlags.Null |
				ts.TypeFlags.Undefined |
				ts.TypeFlags.EnumLike)
		)
			return true;
		// Only the built-in Date, not an unrelated class named Date.
		return (
			type.symbol?.name === 'Date' &&
			(type.symbol.declarations?.some((d) =>
				/[/\\]lib\.[^/\\]+\.d\.ts$/.test(d.getSourceFile().fileName),
			) ??
				false)
		);
	};

	const getObjectProperties = (
		type: TypeScript.Type,
		node: TypeScript.Node,
		label: string,
	): TypeScript.Symbol[] => {
		if (
			isUnsupportedType(type) ||
			type.isUnion() ||
			checker.isArrayType(type) ||
			checker.isTupleType(type) ||
			!(type.flags & ts.TypeFlags.Object) ||
			checker.getIndexInfosOfType(type).length ||
			checker.getSignaturesOfType(type, ts.SignatureKind.Call).length
		) {
			fail(
				node,
				`${label} must be a concrete object shape without unions, index signatures or call signatures.`,
			);
		}
		return checker.getPropertiesOfType(type);
	};

	function classConstructor(
		target: TypeScript.Type,
		method: TypeScript.MethodDeclaration,
	): string | undefined {
		if (!(target.symbol?.flags & ts.SymbolFlags.Class)) return undefined;

		const declaration = target.symbol.declarations?.find(ts.isClassDeclaration);
		if (!declaration || hasModifier(declaration, ts.SyntaxKind.AbstractKeyword)) {
			fail(
				method,
				'Class targets must be concrete classes with a public constructor callable without arguments.',
			);
		}

		// A type alias has no runtime constructor. Require the class's value name explicitly.
		const returnType = method.type;
		if (!returnType || !ts.isTypeReferenceNode(returnType)) {
			fail(method, 'Use a runtime class reference as the return type for a class target.');
		}
		const reference = checker.getSymbolAtLocation(returnType.typeName);
		const resolved =
			reference &&
			(reference.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(reference) : reference);
		if (resolved !== target.symbol) {
			fail(method, 'Class targets must use the class name, not a type alias, as the return type.');
		}

		let rootName: TypeScript.EntityName = returnType.typeName;
		while (ts.isQualifiedName(rootName)) rootName = rootName.left;
		const rootSymbol = checker.getSymbolAtLocation(rootName);
		for (const imported of rootSymbol?.declarations ?? []) {
			let node: TypeScript.Node | undefined = imported;
			while (node && !ts.isSourceFile(node)) {
				if (
					(ts.isImportClause(node) ||
						ts.isImportSpecifier(node) ||
						ts.isImportEqualsDeclaration(node)) &&
					node.isTypeOnly
				) {
					fail(
						method,
						'Class targets need a runtime import. Replace import type with a regular import.',
					);
				}
				node = node.parent;
			}
		}

		const constructorType = checker.getTypeOfSymbolAtLocation(target.symbol, declaration);
		const constructors = checker.getSignaturesOfType(constructorType, ts.SignatureKind.Construct);
		const acceptsNoArguments = constructors.some((signature) =>
			signature.parameters.every((parameter) => {
				const node = parameter.valueDeclaration;
				return (
					Boolean(parameter.flags & ts.SymbolFlags.Optional) ||
					(node &&
						ts.isParameter(node) &&
						Boolean(node.initializer || node.questionToken || node.dotDotDotToken))
				);
			}),
		);
		if (!acceptsNoArguments) {
			fail(
				method,
				'Class targets must have a public constructor callable without arguments; constructor argument mapping is unsupported.',
			);
		}

		// The final compiler pass also checks constructor visibility and runtime name resolution.
		return returnType.getText();
	}

	function targetFields(
		target: TypeScript.Type,
		method: TypeScript.MethodDeclaration,
		isClass: boolean,
	): TypeScript.Symbol[] {
		return getObjectProperties(target, method, 'Target').filter((property) => {
			const declarations = property.declarations ?? [];
			const behavior = declarations.some(
				(node) =>
					ts.isMethodSignature(node) ||
					ts.isMethodDeclaration(node) ||
					ts.isGetAccessorDeclaration(node) ||
					ts.isSetAccessorDeclaration(node),
			);
			const internal = declarations.some(
				(node) =>
					hasModifier(node, ts.SyntaxKind.PrivateKeyword) ||
					hasModifier(node, ts.SyntaxKind.ProtectedKeyword) ||
					(ts.isPropertyDeclaration(node) && ts.isPrivateIdentifier(node.name)),
			);

			// Class behavior and internal state belong to the constructor/prototype, not the input.
			if (isClass && (behavior || internal)) return false;
			if (behavior || internal || property.name.startsWith('__@')) {
				fail(method, `Target '${property.name}' is not a supported public data field.`);
			}
			if (
				isClass &&
				declarations.some((node) => hasModifier(node, ts.SyntaxKind.ReadonlyKeyword))
			) {
				fail(
					method,
					`Class target field '${property.name}' is readonly; mapping requires writable public fields.`,
				);
			}
			return true;
		});
	}

	// Resolve each contract against the source and target types before generating methods.
	for (const file of program.getSourceFiles()) {
		if (!roots.includes(file.fileName) || file.isDeclarationFile) continue;
		for (const mapperClass of file.statements) {
			if (
				!ts.isClassDeclaration(mapperClass) ||
				!tags(mapperClass).some((t) => t.tagName.text === 'mapper')
			)
				continue;
			try {
				if (
					!mapperClass.name ||
					!hasModifier(mapperClass, ts.SyntaxKind.ExportKeyword) ||
					!hasModifier(mapperClass, ts.SyntaxKind.AbstractKeyword) ||
					hasModifier(mapperClass, ts.SyntaxKind.DefaultKeyword) ||
					mapperClass.typeParameters?.length ||
					mapperClass.heritageClauses?.length
				) {
					fail(
						mapperClass,
						'@mapper requires a named exported abstract class without generics or inheritance.',
					);
				}
				if (
					mapperClass.members.some(
						(m) => ts.isConstructorDeclaration(m) || ts.isPropertyDeclaration(m),
					)
				) {
					fail(mapperClass, 'Mapper contracts cannot have constructors or instance fields.');
				}

				const name = mapperClass.name.text;
				const changes: SourceEdit[] = [];

				for (const method of mapperClass.members) {
					if (!hasModifier(method, ts.SyntaxKind.AbstractKeyword)) continue;
					if (
						!ts.isMethodDeclaration(method) ||
						!ts.isIdentifier(method.name) ||
						method.typeParameters?.length ||
						hasModifier(method, ts.SyntaxKind.ProtectedKeyword) ||
						hasModifier(method, ts.SyntaxKind.PrivateKeyword) ||
						method.parameters.length !== 1 ||
						!method.type ||
						!method.parameters[0]?.type ||
						method.parameters[0].questionToken ||
						method.parameters[0].dotDotDotToken ||
						method.parameters[0].initializer
					) {
						fail(
							method,
							'Mapping methods must be public, non-generic, with one required typed parameter and an explicit return type.',
						);
					}

					const parameter = method.parameters[0];
					if (!parameter?.type) fail(method, 'Mapping parameter must have an explicit type.');

					const signature = checker.getSignatureFromDeclaration(method);
					if (!signature) fail(method, 'Unable to resolve mapping signature.');

					const source = getSymbolType(signature.parameters[0]);
					const target = checker.getReturnTypeOfSignature(signature);
					const sourceProperties = new Map(
						getObjectProperties(source, method, 'Source').map((p) => [p.name, p]),
					);
					const constructor = classConstructor(target, method);
					const properties = targetFields(target, method, constructor !== undefined);
					if (!properties.length) fail(method, 'Empty targets are unsupported.');

					const rules = new Map<string, FieldRule>();
					for (const tag of tags(method)) {
						const tagName = tag.tagName.text;
						if (tagName !== 'map' && tagName !== 'convert') continue;

						let parsedRule: ReturnType<typeof parseFieldRule>;
						try {
							parsedRule = parseFieldRule(tagName, text(tag));
						} catch (error) {
							fail(tag, error instanceof Error ? error.message : String(error));
						}

						const { key, value } = parsedRule;
						if (!properties.some((p) => p.name === key))
							fail(tag, `Unknown target field '${key}'.`);

						const rule = rules.get(key) ?? {};
						if (rule[tagName]) fail(tag, `Duplicate @${tagName} for '${key}'.`);
						rule[tagName] = value;
						rules.set(key, rule);
					}

					const assignments: string[] = [];
					for (const property of properties) {
						const targetType = getSymbolType(property);
						if (isUnsupportedType(targetType))
							fail(method, `Target '${property.name}' has an unsupported type.`);

						const rule = rules.get(property.name) ?? {};
						const sourceName = rule.map ?? property.name;
						const sourceProperty = sourceProperties.get(sourceName);
						if (!sourceProperty)
							fail(
								method,
								`Unmapped target '${property.name}': source field '${sourceName}' is missing (optional fields also require an explicit source).`,
							);

						const sourceType = getSymbolType(sourceProperty);
						if (isUnsupportedType(sourceType))
							fail(method, `Source '${sourceName}' has an unsupported type.`);

						let expression = `source[${JSON.stringify(sourceName)}]`;
						if (rule.convert) {
							const converter = mapperClass.members.find(
								(m): m is TypeScript.MethodDeclaration =>
									ts.isMethodDeclaration(m) &&
									ts.isIdentifier(m.name) &&
									m.name.text === rule.convert &&
									!!m.body,
							);
							if (
								!converter ||
								hasModifier(converter, ts.SyntaxKind.PrivateKeyword) ||
								hasModifier(converter, ts.SyntaxKind.StaticKeyword) ||
								converter.typeParameters?.length
							) {
								fail(
									method,
									`Converter '${rule.convert}' must be a concrete public/protected instance method on the contract.`,
								);
							}

							const conversion = checker.getSignatureFromDeclaration(converter);
							if (!conversion) fail(converter, 'Unable to resolve converter signature.');
							if (
								conversion.parameters.length !== 1 ||
								!checker.isTypeAssignableTo(sourceType, getSymbolType(conversion.parameters[0]))
							) {
								fail(
									method,
									`Converter '${rule.convert}' cannot accept field '${sourceName}' (${checker.typeToString(sourceType)}).`,
								);
							}

							const converted = checker.getReturnTypeOfSignature(conversion);
							if (
								isUnsupportedType(converted) ||
								!checker.isTypeAssignableTo(converted, targetType)
							)
								fail(
									method,
									`Converter '${rule.convert}' cannot produce target '${property.name}' (${checker.typeToString(targetType)}).`,
								);

							expression = `this.${rule.convert}(${expression})`;
						} else {
							if (!canCopyDirectly(sourceType) || !canCopyDirectly(targetType))
								fail(
									method,
									`Field '${property.name}' needs an explicit converter: automatic nested-object/array copying is disabled.`,
								);
							if (!checker.isTypeAssignableTo(sourceType, targetType))
								fail(
									method,
									`Field '${property.name}': ${checker.typeToString(sourceType)} is not assignable to ${checker.typeToString(targetType)}; add @convert.`,
								);
						}

						// Under exactOptionalPropertyTypes, omit an absent optional field instead of assigning undefined.
						const optional =
							property.flags & ts.SymbolFlags.Optional &&
							sourceProperty.flags & ts.SymbolFlags.Optional &&
							!rule.convert;
						if (constructor) {
							const assignment = `target[${JSON.stringify(property.name)}] = ${expression};`;
							assignments.push(
								optional
									? `    if (${JSON.stringify(sourceName)} in source) { ${assignment} }`
									: `    ${assignment}`,
							);
						} else {
							assignments.push(
								optional
									? `      ...(${JSON.stringify(sourceName)} in source ? { ${JSON.stringify(property.name)}: ${expression} } : {}),`
									: `      ${JSON.stringify(property.name)}: ${expression},`,
							);
						}
					}

					const body = constructor
						? `    const target = new ${constructor}();\n${assignments.join('\n')}\n    return target;`
						: `    return {\n${assignments.join('\n')}\n    };`;

					changes.push({
						start: method.getStart(),
						end: method.end,
						text: `${method.name.text}(source: ${parameter.type.getText()}): ${method.type.getText()} {\n${body}\n  }`,
					});
				}

				if (!changes.length)
					fail(mapperClass, 'A mapper must declare at least one abstract mapping method.');

				changes.push({
					start: mapperClass.end,
					end: mapperClass.end,
					text: `\nObject.defineProperty(${name}, Symbol.for('mappergen/generated'), { value: true });\n`,
				});

				const existing = edits.get(file.fileName) ?? [];
				edits.set(file.fileName, [...existing, ...changes]);
			} catch (error) {
				errors.push(error instanceof Error ? error.message : String(error));
			}
		}
	}
	if (errors.length) throw new Error(errors.join('\n'));

	// Apply edits to copies of the source; handwritten files stay untouched.
	for (const [file, changes] of edits) {
		const sourceFile = program.getSourceFile(file);
		if (!sourceFile) throw new Error(`Cannot resolve source file: ${file}`);

		const content = new MagicString(sourceFile.text);
		for (const edit of changes.sort((a, b) => b.start - a.start)) {
			if (edit.start === edit.end) content.appendLeft(edit.start, edit.text);
			else content.overwrite(edit.start, edit.end, edit.text);
		}

		outputs.set(resolve(file), content.toString());
		mapped.set(resolve(file), {
			code: content.toString(),
			map: content.generateMap({ source: resolve(file), includeContent: true, hires: true }),
		});
	}

	if (!outputs.size) throw new Error('No @mapper contracts found in the project.');

	// Typecheck transformed modules in memory, including handwritten contracts/converters.
	const host = ts.createCompilerHost(parsed.options);
	const originalRead = host.readFile.bind(host);
	const originalExists = host.fileExists.bind(host);
	host.readFile = (f) => outputs.get(resolve(f)) ?? originalRead(f);
	host.fileExists = (f) => outputs.has(resolve(f)) || originalExists(f);

	const validated = ts.createProgram(
		[...roots, ...outputs.keys()],
		{ ...parsed.options, noEmit: true },
		host,
	);
	const diagnostics = ts.getPreEmitDiagnostics(validated);
	if (diagnostics.length) throw new Error(format(diagnostics));

	return mapped;
}
