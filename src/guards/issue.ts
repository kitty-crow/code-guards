import type ts from "typescript";
import type { GuardName } from "../model.ts";

/** Internal input to rule-specific emitters, before a source Location is attached. */
export type Issue = {
  guard: GuardName;
  code: string;
  node: ts.Node;
  message: string;
  reason: string;
  suggestion: string;
};

type RelatedIssue = Issue & { related: ts.Node };

export type EmitIssue = (issue: Issue | RelatedIssue) => void;
