import { getMapper } from 'mappergen';

// An ordinary contract, useful on its own and reusable from other mappers.
export interface UserRow {
	id: string;
	email: string;
	passwordHash: string;
}

export class UserDto {
	id!: string;
	email!: string;
}

/** @mapper */
export abstract class UserMapping {
	abstract toDto(source: UserRow): UserDto;

	/** @delegate toDto */
	abstract toDtos(source: readonly UserRow[]): UserDto[];
}

export const userMapping = getMapper(UserMapping);
