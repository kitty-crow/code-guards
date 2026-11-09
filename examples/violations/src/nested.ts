// Intentionally poor control flow, yet valid TypeScript.
export function authorise(connected: boolean, allowed: boolean): string {
  if (connected) {
    if (allowed) return "authorised";
  }
  return "pending";
}

export function selectRoute(primary: boolean, secondary: boolean): string {
  if (primary) return "primary";
  else if (secondary) return "secondary";
  return "none";
}

export function preferable(connected: boolean, allowed: boolean): string {
  if (!connected) return "pending";
  if (!allowed) return "pending";
  return "authorised";
}
