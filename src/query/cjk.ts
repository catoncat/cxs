import { isCjkToken } from "../tokenize";

// Re-export for callers that still rely on the old helper name.
export function isCjkTerm(token: string): boolean {
  return isCjkToken(token);
}
