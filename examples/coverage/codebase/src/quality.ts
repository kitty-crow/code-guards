import { alpha } from "./a.ts";
import { beta } from "./b.ts";
import { gamma } from "./c.ts";
import { delta } from "./d.ts";
import { e } from "./e.ts";
import { f } from "./f.ts";
import { g } from "./g.ts";
import { h } from "./h.ts";
import { i } from "./i.ts";
import { j } from "./j.ts";

export function doStuff(a: number, b: number, c: number, d: number, e: number, f: number, g: number): number { return a+b+c+d+e+f+g; }
export function unfinished(): void { /* TODO: implement this later */ }
export function unreachable(): number { return 1; console.log("never reached"); }
export function redundant(ok: boolean): boolean { if (ok) { return true; } else { return false; } }
export function forced(text: string | undefined): string { return text! as any; }
export function choose(state: "open" | "closed"): void { switch (state) { case "open": return; } }
export function mutable(): number { let value = 5; return value; }
async function asyncWork(): Promise<void> { return; }
export function noErrors(): void { asyncWork(); try { throw Error("failure"); } catch {} }
export class Misplaced {
  forward(x: number): number { return alpha(x); }
  small(x: number): number { return x + 1; }
  complex(value: number): number {
    const a = Math.round(value);
    const b = Math.floor(value);
    const c = Math.ceil(value);
    const d = Math.abs(value);
    const e = Math.trunc(value);
    const f = Math.min(value, 3);
    const g = Math.max(value, 6);
    const h = Math.sign(value);
    const k = Math.sqrt(Math.abs(value));
    const l = Math.pow(value, 2);
    const m = Number.isFinite(value) ? value : 0;
    const n = a + b + c;
    return n + d + e + f + g + h + k + l + m;
  }
}

export function highCoupling(number: number): number {
  const one = alpha(number);
  const two = beta(number);
  const three = gamma(number);
  const four = delta(number);
  return one + two + three + four + e + f + g + h + i + j;
}

export function nested(condition: boolean, permitted: boolean): string {
  if (condition) {
    if (permitted) return "yes";
  }
  return "no";
}

export function longUndocumentedDecision(value: number): number {
  if (value === 0) {
    value += 1;
  }
  if (value === 1) {
    value += 2;
  }
  if (value === 2) {
    value += 3;
  }
  if (value === 3) {
    value += 4;
  }
  if (value === 4) {
    value += 5;
  }
  if (value === 5) {
    value += 6;
  }
  if (value === 6) {
    value += 7;
  }
  if (value === 7) {
    value += 8;
  }
  if (value === 8) {
    value += 9;
  }
  if (value === 9) {
    value += 10;
  }
  if (value === 10) {
    value += 11;
  }
  if (value === 11) {
    value += 12;
  }
  if (value === 12) {
    value += 13;
  }
  if (value === 13) {
    value += 14;
  }
  if (value === 14) {
    value += 15;
  }
  if (value === 15) {
    value += 16;
  }
  if (value === 16) {
    value += 17;
  }
  if (value === 17) {
    value += 18;
  }
  if (value === 18) {
    value += 19;
  }
  if (value === 19) {
    value += 20;
  }
  if (value === 20) {
    value += 21;
  }
  if (value === 21) {
    value += 22;
  }
  if (value === 22) {
    value += 23;
  }
  if (value === 23) {
    value += 24;
  }
  if (value === 24) {
    value += 25;
  }
  if (value === 25) {
    value += 26;
  }
  if (value === 26) {
    value += 27;
  }
  if (value === 27) {
    value += 28;
  }
  if (value === 28) {
    value += 29;
  }
  if (value === 29) {
    value += 30;
  }
  return value;
}
