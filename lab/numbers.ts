// docs/NUMBERS.md is the single source of truth for Mesh savings numbers. Its
// rule: never quote a number without saying whether it is LIVE (real API
// traffic, real money) or SIMULATOR (modelled). The lab's own figures are all
// SIMULATOR and experimental — they are not in that table, so the lab always
// LEADS with the live number read from the doc itself (linked, never copied)
// and labels everything else.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type LiveNumbers = {
  /** The current headline LIVE saving, percent. Undefined if the doc could not be parsed. */
  headlinePercent?: number;
  headlineDescription?: string;
  /** Per-agent LIVE savings inside the headline basket, e.g. { coding: 38.1, rag: 22 }. */
  perAgent: Record<string, number>;
  reconciled?: string;
  source: "docs/NUMBERS.md";
};

const NUMBERS_PATH = fileURLToPath(new URL("../docs/NUMBERS.md", import.meta.url));

/** Parse the LIVE figures out of docs/NUMBERS.md. Never throws; missing parts stay undefined. */
export function readLiveNumbers(path: string = NUMBERS_PATH): LiveNumbers {
  const result: LiveNumbers = { perAgent: {}, source: "docs/NUMBERS.md" };
  if (!existsSync(path)) return result;
  const text = readFileSync(path, "utf8");

  result.reconciled = /Last reconciled:\s*([0-9-]+)/.exec(text)?.[1];

  // The row marked as the current headline live number: | **18.2%** | <what> | ... |
  for (const line of text.split("\n")) {
    if (!/CURRENT headline live number/i.test(line)) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    const percent = /([\d.]+)%/.exec(cells[1] ?? "")?.[1];
    if (percent) {
      result.headlinePercent = Number(percent);
      result.headlineDescription = cells[2];
    }
  }

  // "Per-agent inside the 18.2% basket: coding **38.1%**, rag **22.0%**, …"
  const perAgent = /Per-agent[^:]*:([\s\S]*?)\n\s*\n/.exec(text)?.[1] ?? "";
  for (const match of perAgent.matchAll(/([a-z][a-z-]*)\s+\*\*([\d.]+)%\*\*/gi)) {
    result.perAgent[match[1]!.toLowerCase()] = Number(match[2]);
  }
  return result;
}
