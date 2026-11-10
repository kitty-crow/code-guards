export function decodeBatch(input: string): string[] {
  return input.split(",").map(item => item.trim());
}

export function sendAlert(recipient: string, message: string): void {
  console.log(recipient, message);
}

export function renderTimeline(events: string[]): string {
  return events.map(event => `<li>${event}</li>`).join("");
}
