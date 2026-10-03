import { getMapper } from 'mappergen';

// No framework, ORM or decorators on the models.
export interface SensorRow {
	id: string;
	sensorName: string;
	reading: string;
	description: string | null;
	internalNote: string;
}

export class SensorDto {
	id!: string;
	name!: string;
	reading!: number;
	// MapperGen bridges `string | null` from the row into this optional field without
	// a converter; a null row value leaves it undefined.
	description?: string;
}

/** @mapper */
export abstract class SensorMapping {
	/**
	 * @map target=name source=sensorName
	 * @convert reading toNumber
	 */
	abstract toDto(source: SensorRow): SensorDto;

	protected toNumber(value: string): number {
		return Number(value);
	}
}

export const sensorMapping = getMapper(SensorMapping);
