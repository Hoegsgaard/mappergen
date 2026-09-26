import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from '@typescript/typescript6';
import { normalizePath } from 'vite';
import type { Plugin, ViteDevServer } from 'vite';

import { generateWithMaps, type GeneratedMapper } from './generate.js';

export interface MapperGenOptions {
	project?: string;
}

/** Vite adapter for in-memory TypeScript mapper generation. */
export function mapperGen({ project = 'tsconfig.mappers.json' }: MapperGenOptions = {}): Plugin {
	let configPath = resolve(project);
	let compiled = new Map<string, GeneratedMapper>();
	let dirty = true;
	let dependencies = new Set<string>();
	let server: ViteDevServer | undefined;
	let unsubscribe: (() => void) | undefined;
	const served = new Set<string>();

	const cleanId = (id: string): string => {
		const path = resolve(id.split('?')[0] ?? id);
		try {
			return normalizePath(realpathSync.native(path));
		} catch {
			// A file that does not exist yet keeps its resolved path; watchers report it on creation.
			return normalizePath(path);
		}
	};

	const relevant = (file: string): boolean => {
		const id = cleanId(file);
		return (
			id === cleanId(configPath) ||
			dependencies.has(id) ||
			(/\.tsx?$/.test(id) && !id.includes('/node_modules/'))
		);
	};

	const invalidate = (file: string): void => {
		if (!relevant(file)) return;
		dirty = true;
		// Include all mapper modules: an imported model can change an automatically mapped field.
		for (const id of served) {
			const graph = server?.moduleGraph;
			const modules = graph?.getModulesByFile(id);
			if (graph && modules) {
				for (const module of modules) {
					graph.invalidateModule(module);
				}
			}
		}
	};

	const compile = (context: { addWatchFile(file: string): void }): void => {
		if (!dirty) return;
		// Set dirty=false only after success; stale generated code must never mask an error.

		const next = generateWithMaps(ts, configPath, {
			onDependencies(files) {
				dependencies = new Set(
					files.map(cleanId).filter((file) => !file.includes('/node_modules/')),
				);
			},
		});

		for (const file of dependencies) context.addWatchFile(file);
		context.addWatchFile(configPath);

		compiled = new Map([...next].map(([file, output]) => [cleanId(file), output]));
		dirty = false;
	};

	return {
		name: 'mappergen',
		enforce: 'pre',

		config() {
			return { ssr: { noExternal: ['mappergen'] } };
		},

		configResolved(config) {
			configPath = resolve(config.root, project);
		},

		configureServer(viteServer) {
			server = viteServer;
			server.watcher.on('change', invalidate);
			server.watcher.on('add', invalidate);
			server.watcher.on('unlink', invalidate);

			unsubscribe = () => {
				viteServer.watcher.off('change', invalidate);
				viteServer.watcher.off('add', invalidate);
				viteServer.watcher.off('unlink', invalidate);
			};
			server.httpServer?.once('close', unsubscribe);
		},

		buildStart() {
			dirty = true;
			compile(this);
		},

		watchChange(id) {
			invalidate(id);
		},

		handleHotUpdate(context) {
			if (!relevant(context.file)) return;
			invalidate(context.file);
			return [
				...new Set([
					...context.modules,
					...[...served].flatMap((id) => [
						...(context.server.moduleGraph.getModulesByFile(id) ?? []),
					]),
				]),
			];
		},

		transform(code, id) {
			compile(this);
			const generated = compiled.get(cleanId(id));
			if (generated === undefined) return null;
			served.add(id.split('?')[0] ?? id);

			// Generation and source maps use the original source. Never discard another plugin's edits.
			const original = generated.map.sourcesContent?.[0];
			if (code.replace(/^\uFEFF/, '') !== original?.replace(/^\uFEFF/, '')) {
				// Re-read on the next attempt: Vite and the compiler may have seen different saves.
				dirty = true;
				this.error(
					`MapperGen: ${cleanId(id)} differs from the source used for generation. The file may have changed during the build; retry after saving. If this persists, check plugin order. Place mapperGen() before other pre-transform plugins that modify mapper files.`,
				);
			}
			return generated;
		},

		closeBundle() {
			unsubscribe?.();
		},
	};
}
