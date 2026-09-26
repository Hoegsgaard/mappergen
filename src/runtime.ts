/** A mapper contract whose implementation is supplied by the build adapter. */
export type MapperContract<T extends object> = abstract new () => T;

const instances = new WeakMap<object, object>();
const marker = Symbol.for('mappergen/generated');

/** Return the cached instance of a transformed mapper contract. */
export function getMapper<T extends object>(contract: MapperContract<T>): T {
	const descriptor = Object.getOwnPropertyDescriptor(contract, marker);
	if (descriptor?.value !== true) {
		throw new Error(
			`MapperGen: ${contract.name} has not been generated. Enable mapperGen() in the Vite/Vitest configuration.`,
		);
	}

	const existing = instances.get(contract);
	// The cache is heterogeneous, but each entry is created from its own constructor below.
	if (existing) return existing as T;

	// Abstract methods have been supplied by the compiler adapter before the marker is set.
	const ConcreteMapper = contract as new () => T;
	const instance = new ConcreteMapper();
	instances.set(contract, instance);

	return instance;
}
