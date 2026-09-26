import { SensorDto, sensorMapping } from './SensorMapping.js';

const result = sensorMapping.toDto({
	id: 'sensor-1',
	sensorName: 'Outdoor temperature',
	reading: '21.5',
	description: null,
	internalNote: 'Maintenance scheduled',
});

console.log(result instanceof SensorDto); // true
console.log(result);
// {
//   id: 'sensor-1',
//   name: 'Outdoor temperature',
//   reading: 21.5,
//   description: undefined,
// }
