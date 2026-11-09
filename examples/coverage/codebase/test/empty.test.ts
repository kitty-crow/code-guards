declare function test(name: string, fn: () => void): void;
test("does nothing", () => { Math.round(2); });
