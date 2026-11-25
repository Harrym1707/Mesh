// A backstop on what a draft may say.
//
// Mesh's rule for figures (docs/NUMBERS.md): never quote a savings number
// without saying whether it is LIVE or SIMULATOR; if a number is not in that
// file it is not a Mesh number. The store runs this check on every draft an
// agent writes (content, outreach, community reply, partnership submission)
// and refuses the write when it fails:
//
//   - every percentage, money amount or multiplier in the text must be
//     declared in the draft's `figures`, with where it comes from;
//   - a Mesh savings figure must be in docs/NUMBERS.md under the label it is
//     given, carry its date, and say whether it is measured out of the box or
//     with named levers switched on; the text must carry the label too;
//   - a third-party figure needs the page it was read on and the day;
//   - the text may not promise a result or sell Mesh as a compressor.
//
// It is a backstop, not a proof: the fact-check stage and Harry's approval
// still read the draft. It catches the undeclared number, not the wrong idea.

import type { DeclaredFigure } from "./types.js";

export type NumbersIndex = {
  /** Figures under the LIVE heading of docs/NUMBERS.md, e.g. "18.2%". */
  live: string[];
  /** Figures under the SIMULATOR heading. */
  simulator: string[];
  reconciled?: string;
};

const FIGURE = /(?:[$£€]\s?\d[\d,]*(?:\.\d+)?\s?(?:[kmb]\b|million\b|billion\b)?|\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?x\b)/gi;

/** The figures in a piece of text, normalised ("18.2 %" and "18.2%" are one figure). */
export function figuresIn(text: string): string[] {
  // "25.9–29.4%" is two figures, 25.9% and 29.4%.
  const expanded = text.replace(/(\d+(?:\.\d+)?)\s?[–-]\s?(\d+(?:\.\d+)?)\s?%/g, "$1% $2%");
  return [...new Set((expanded.match(FIGURE) ?? []).map((token) => token.replace(/\s+/g, "").toLowerCase()))];
}

/** Read the labelled figures out of docs/NUMBERS.md. Reference figures are not Mesh savings and are left out. */
export function parseNumbers(markdown: string): NumbersIndex {
  const index: NumbersIndex = { live: [], simulator: [] };
  index.reconciled = /Last reconciled:\s*([0-9-]+)/.exec(markdown)?.[1];
  let section: "live" | "simulator" | undefined;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) {
      section = /^## LIVE/i.test(line) ? "live" : /^## SIMULATOR/i.test(line) ? "simulator" : undefined;
      continue;
    }
    if (section) for (const figure of figuresIn(line)) if (!index[section].includes(figure)) index[section].push(figure);
  }
  return index;
}

const PROMISES: { pattern: RegExp; why: string }[] = [
  { pattern: /\bguarantee/i, why: 'it uses "guarantee"; Mesh promises no result' },
  { pattern: /\bwill (?:cut|reduce|lower|shrink|halve|slash) your\b/i, why: "it promises a smaller bill; Mesh reports what it measured, it does not promise" },
  { pattern: /\b(?:a|your) (?:smaller|lower) bill\b/i, why: "it promises a smaller bill" },
];

function sellsAsCompressor(text: string): boolean {
  for (const sentence of text.split(/(?<=[.!?\n])/)) {
    if (!/\bmesh\b/i.test(sentence) || !/\bcompress(?:or|es|ion|ing)?\b/i.test(sentence)) continue;
    if (/\b(?:not|isn't|is no|never|does not|doesn't|rather than|unlike)\b/i.test(sentence)) continue;
    return true;
  }
  return false;
}

/** Everything wrong with a draft's figures and promises. Empty when it may be stored. */
export function draftProblems(texts: readonly string[], figures: readonly DeclaredFigure[], numbers: NumbersIndex | undefined): string[] {
  const problems: string[] = [];
  const text = texts.join("\n");

  const declared = new Set(figures.flatMap((f) => figuresIn(f.figure)));
  for (const found of figuresIn(text)) {
    if (!declared.has(found)) problems.push(`the figure "${found}" is in the text but not declared in figures with its source`);
  }

  for (const figure of figures) {
    const name = `figure "${figure.figure}"`;
    if (figure.kind === "mesh-savings") {
      if (figure.source !== "docs/NUMBERS.md") problems.push(`${name}: a Mesh savings figure is quoted from docs/NUMBERS.md and nowhere else`);
      if (!figure.label) problems.push(`${name}: needs its label, LIVE or SIMULATOR`);
      if (!figure.date) problems.push(`${name}: needs the date it was measured or reconciled`);
      if (!figure.basis) problems.push(`${name}: needs its basis, out-of-the-box or levers-on`);
      if (figure.basis === "levers-on" && !(figure.levers && figure.levers.length > 0)) problems.push(`${name}: levers-on needs the levers named`);
      if (!numbers) {
        problems.push(`${name}: docs/NUMBERS.md could not be read, so no Mesh savings figure can be checked`);
      } else if (figure.label) {
        const allowed = figure.label === "LIVE" ? numbers.live : numbers.simulator;
        for (const token of figuresIn(figure.figure)) {
          if (!allowed.includes(token)) problems.push(`${name}: ${token} is not a ${figure.label} figure in docs/NUMBERS.md`);
        }
        if (!text.includes(figure.label)) problems.push(`${name}: the text must carry the label ${figure.label} beside it`);
      }
    } else if (figure.kind === "third-party") {
      if (!/^https?:\/\//.test(figure.source)) problems.push(`${name}: a third-party figure needs the URL of the page it was read on`);
      if (!figure.readOn) problems.push(`${name}: a third-party figure needs the day the page was read`);
    }
  }

  for (const { pattern, why } of PROMISES) if (pattern.test(text)) problems.push(why);
  if (sellsAsCompressor(text)) problems.push("it describes Mesh as a compressor; Mesh is not sold as one");
  return problems;
}
