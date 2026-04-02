export function parsePositiveInteger(
  rawValue: string | null,
): number | null {
  if (!rawValue) return null;

  const trimmed = rawValue.trim();
  if (!/^\d+$/.test(trimmed)) return null;

  const value = Number(trimmed);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function normalizeXdrBase64(xdrBase64: string): string {
  return xdrBase64.replace(/\s+/g, "");
}
