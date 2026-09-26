/** Parse one annotation without depending on the TypeScript compiler. */
export function parseFieldRule(
	tagName: 'map' | 'convert',
	comment: string,
): { key: string; value: string } {
	if (tagName === 'map') {
		const match = /^(target|source)\s*=\s*([^\s=]+)\s+(target|source)\s*=\s*([^\s=]+)$/.exec(
			comment,
		);

		if (!match?.[1] || !match[2] || !match[3] || !match[4] || match[1] === match[3]) {
			throw new Error(
				'Expected @map target=targetField source=sourceField (each named argument exactly once).',
			);
		}

		return {
			key: match[1] === 'target' ? match[2] : match[4],
			value: match[1] === 'source' ? match[2] : match[4],
		};
	}

	const parts = comment.split(/\s+/);
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		throw new Error('Expected @convert targetField converterMethod.');
	}

	return { key: parts[0], value: parts[1] };
}
