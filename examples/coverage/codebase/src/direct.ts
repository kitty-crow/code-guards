export function bypass(): Promise<Response> { return fetch("https://example.com/unsafe"); }
