import { resolve } from "node:path";
import type { Selector } from "./types";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseSelectorJson(value: string): Selector {
  let raw: unknown;
  try {
    raw = JSON.parse(value) as unknown;
  } catch (error) {
    throw new SelectorParseError(`invalid selector JSON: ${describeError(error)}`);
  }
  return canonicalizeSelector(raw);
}

export class SelectorParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectorParseError";
  }
}

export function canonicalizeSelector(value: unknown): Selector {
  if (!isRecord(value)) throw new SelectorParseError("selector must be an object");
  const kind = value.kind;
  const root = requireString(value.root, "root");
  const base = { root: resolve(root) };

  if (kind === "all") {
    return { kind, ...base };
  }
  if (kind === "date_range") {
    const fromDate = requireDate(value.fromDate, "fromDate");
    const toDate = requireDate(value.toDate, "toDate");
    assertDateOrder(fromDate, toDate);
    return { kind, ...base, fromDate, toDate };
  }
  if (kind === "cwd") {
    return { kind, ...base, cwd: requireString(value.cwd, "cwd") };
  }
  if (kind === "cwd_date_range") {
    const fromDate = requireDate(value.fromDate, "fromDate");
    const toDate = requireDate(value.toDate, "toDate");
    assertDateOrder(fromDate, toDate);
    return { kind, ...base, cwd: requireString(value.cwd, "cwd"), fromDate, toDate };
  }

  throw new SelectorParseError("selector kind must be all, date_range, cwd, or cwd_date_range");
}

export function selectorImplies(covering: Selector, requested: Selector): boolean {
  if (covering.root !== requested.root) return false;
  if (covering.kind === "all") return true;

  if (covering.kind === "date_range") {
    if (requested.kind === "date_range") return containsDateRange(covering, requested);
    if (requested.kind === "cwd_date_range") return containsDateRange(covering, requested);
    return false;
  }

  if (covering.kind === "cwd") {
    if (requested.kind === "cwd") return covering.cwd === requested.cwd;
    if (requested.kind === "cwd_date_range") return covering.cwd === requested.cwd;
    return false;
  }

  if (requested.kind !== "cwd_date_range") return false;
  return covering.cwd === requested.cwd && containsDateRange(covering, requested);
}

export function selectorContainsFile(selector: Selector, file: { pathDate: string | null; cwd: string }): boolean {
  if (selector.kind === "all") return true;
  if (selector.kind === "cwd") return file.cwd === selector.cwd;
  if (!file.pathDate) return false;
  if (selector.kind === "date_range") return dateInRange(file.pathDate, selector.fromDate, selector.toDate);
  return file.cwd === selector.cwd && dateInRange(file.pathDate, selector.fromDate, selector.toDate);
}

export function selectorStorageKey(selector: Selector): string {
  return JSON.stringify(selector);
}

function containsDateRange(
  covering: Extract<Selector, { fromDate: string; toDate: string }>,
  requested: Extract<Selector, { fromDate: string; toDate: string }>,
): boolean {
  return covering.fromDate <= requested.fromDate && covering.toDate >= requested.toDate;
}

function dateInRange(date: string, fromDate: string, toDate: string): boolean {
  return date >= fromDate && date <= toDate;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SelectorParseError(`selector.${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireDate(value: unknown, field: string): string {
  const date = requireString(value, field);
  if (!DATE_RE.test(date)) {
    throw new SelectorParseError(`selector.${field} must be YYYY-MM-DD`);
  }
  return date;
}

function assertDateOrder(fromDate: string, toDate: string): void {
  if (fromDate > toDate) throw new SelectorParseError("fromDate must be <= toDate");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
