export function isStringAnInteger(str: string): boolean {
	const parsedValue = Number.parseInt(str, 10);
	return !Number.isNaN(parsedValue) && Number.isInteger(Number(str));
}
