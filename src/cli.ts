#!/usr/bin/env node
import { resolve } from 'node:path';

import ts from '@typescript/typescript6';

import { generate } from './generate.js';

const args = process.argv.slice(2);
let project = 'tsconfig.json';

try {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--validate') continue;
		if (arg === '--project') {
			const value = args[++i];
			if (!value || value.startsWith('--')) throw new Error('Missing value for --project');
			project = value;
		} else if (arg === '--help') {
			console.log(
				'mappergen --project tsconfig.json [--validate]\nValidates mappings in memory; never writes generated source files.',
			);
			process.exit(0);
		} else throw new Error(`Unknown argument: ${arg}`);
	}

	// Use the same generation and type checks as the build adapter.
	const files = [...generate(ts, resolve(project)).keys()];
	console.log(`Validated ${files.length} mapper file(s).`);
	for (const file of files) console.log(file);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
