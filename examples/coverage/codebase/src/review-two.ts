export function repeatedCount(input: string): number {
  const normalised = String(input).trim().toLowerCase();
  const sections = normalised.split(',').map(part => part.trim());
  const filtered = sections.filter(part => part.length > 3);
  return filtered.length;
}
