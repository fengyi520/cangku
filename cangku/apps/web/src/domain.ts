export function splitList(value: string) {
  return value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
}

export function signed(value: number) {
  return value > 0 ? `+${value}` : String(value);
}

export function colorSlot(value: string) {
  const hash = [...value].reduce((result, character) => ((result << 5) - result + character.charCodeAt(0)) | 0, 0);
  return Math.abs(hash) % 4;
}
