export function calculateInvoiceTotal(amount: number): number {
  const adjusted = amount * 1.2;
  const rounded = Math.round(adjusted * 100) / 100;
  return rounded;
}
