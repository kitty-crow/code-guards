import { normaliseName } from "./a.js";
import { normaliseEmail } from "./b.js";
import { normaliseCompany } from "./c.js";
import { normaliseReference } from "./d.js";

export function prepareRequest(raw: string, flags: readonly string[]): string {
  let value = raw;
  value = normaliseName(value);
  value = normaliseEmail(value);
  value = normaliseCompany(value);
  value = normaliseReference(value);
  if (flags.includes("alpha")) value += "A";
  if (flags.includes("beta")) value += "B";
  if (flags.includes("gamma")) value += "C";
  if (flags.includes("delta")) value += "D";
  if (flags.includes("epsilon")) value += "E";
  if (flags.includes("zeta")) value += "F";
  if (flags.includes("eta")) value += "G";
  if (flags.includes("theta")) value += "H";
  if (flags.includes("iota")) value += "I";
  if (flags.includes("kappa")) value += "J";
  if (flags.includes("lambda")) value += "K";
  if (flags.includes("mu")) value += "L";
  if (flags.includes("nu")) value += "M";
  if (flags.includes("xi")) value += "N";
  if (flags.includes("omicron")) value += "O";
  if (flags.includes("pi")) value += "P";
  if (flags.includes("rho")) value += "Q";
  if (flags.includes("sigma")) value += "R";
  if (flags.includes("tau")) value += "S";
  if (flags.includes("upsilon")) value += "T";
  if (flags.includes("phi")) value += "U";
  if (flags.includes("chi")) value += "V";
  if (flags.includes("psi")) value += "W";
  if (flags.includes("omega")) value += "X";
  if (flags.includes("one")) value += "1";
  if (flags.includes("two")) value += "2";
  if (flags.includes("three")) value += "3";
  if (flags.includes("four")) value += "4";
  if (flags.includes("five")) value += "5";
  if (flags.includes("six")) value += "6";
  if (flags.includes("seven")) value += "7";
  if (flags.includes("eight")) value += "8";
  if (flags.includes("nine")) value += "9";
  if (flags.includes("ten")) value += "0";
  if (flags.includes("eleven")) value += "_";
  if (flags.includes("twelve")) value += "-";
  if (flags.includes("thirteen")) value += "!";
  if (flags.includes("fourteen")) value += "?";
  return value;
}

export class RequestFormatter {
  short(value: string): string {
    return value.trim();
  }
}
