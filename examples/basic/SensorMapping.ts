import { getMapper } from 'mappergen';

import { UserDto, UserMapping, type UserRow } from './UserMapping.js';

// No framework, ORM or decorators on the models.
export interface PlacementRow {
	building: string;
	room: string;
	wiringNotes: string;
}

export interface SensorRow {
	id: string;
	sensorName: string;
	reading: string;
	description: string | null;
	owner: UserRow | null;
	placement: PlacementRow;
	internalNote: string;
}

export class PlacementDto {
	building!: string;
	room!: string;
}

export class SensorDto {
	id!: string;
	name!: string;
	reading!: number;
	// MapperGen bridges `string | null` from the row into this optional field without
	// a converter; a null row value leaves it undefined.
	description?: string;
	owner?: UserDto;
	placement!: PlacementDto;
}

/** @mapper */
export abstract class SensorMapping {
	/**
	 * @map target=name source=sensorName
	 * @convert reading toNumber
	 * @delegate owner UserMapping.toDto
	 * @delegate placement toPlacement
	 */
	abstract toDto(source: SensorRow): SensorDto;

	abstract toPlacement(source: PlacementRow): PlacementDto;

	protected toNumber(value: string): number {
		return Number(value);
	}
}

export const sensorMapping = getMapper(SensorMapping);
