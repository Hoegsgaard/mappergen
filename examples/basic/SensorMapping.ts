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
	description?: string;
}

/** @mapper */
export abstract class SensorMapping {
	/**
	 * @map target=name source=sensorName
	 * @convert reading toNumber
	 * @convert description nullToUndefined
	 */
	abstract toDto(source: SensorRow): SensorDto;

	protected toNumber(value: string): number {
		return Number(value);
	}

	protected nullToUndefined(value: string | null): string | undefined {
		return value ?? undefined;
	}
}

export const sensorMapping = getMapper(SensorMapping);
