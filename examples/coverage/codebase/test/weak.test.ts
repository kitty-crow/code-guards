declare function test(label: string, run: () => void): void;
declare const assert: {ok(value: unknown): void};
test('tautology', () => { assert.ok(true); });
