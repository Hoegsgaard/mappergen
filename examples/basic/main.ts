import { userMapping } from './UserMapping.js';
import { SensorDto, sensorMapping } from './SensorMapping.js';

const result = sensorMapping.toDto({
	id: 'sensor-1',
	sensorName: 'Outdoor temperature',
	reading: '21.5',
	description: null,
	owner: { id: 'user-1', email: 'ada@example.com', passwordHash: 'never mapped' },
	placement: { building: 'Hall C', room: '2.14', wiringNotes: 'never mapped' },
	internalNote: 'Maintenance scheduled',
});

console.log(result instanceof SensorDto); // true
console.log(result);
// {
//   id: 'sensor-1',
//   name: 'Outdoor temperature',
//   reading: 21.5,
//   description: undefined,
//   owner: UserDto { id: 'user-1', email: 'ada@example.com' },
//   placement: PlacementDto { building: 'Hall C', room: '2.14' },
// }

console.log(
	userMapping.toDto({ id: 'user-2', email: 'grace@example.com', passwordHash: 'never mapped' }),
);
// UserDto { id: 'user-2', email: 'grace@example.com' }
