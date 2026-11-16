// NOT part of any build. This file is deliberately wrong: `capture.sh` compiles
// it to record what a real TypeScript compiler prints when an agent's edit does
// not type-check. Nothing imports it, and no tsconfig or test includes it.
import { minifyToolSchemas } from "../../packages/core/src/tool-schema.js";
import { approximateTokenCount } from "../../packages/core/src/token-reduction.js";

type Order = { id: string; lines: Array<{ sku: string; quantity: number }>; total: number };

function totalOf(order: Order): number {
  return order.lines.reduce((sum, line) => sum + line.quantity * line.price, 0);
}

const order: Order = { id: 42, lines: [{ sku: "A-1", quantity: "2" }], total: "9.50" };

const result = minifyToolSchemas("not an array", { descriptions: "shorten" });
const saved: string = result.losslessTokensSaved;
const tokens = approximateTokenCount(order);
const missing = result.tools.map((tool) => tool.name.toUpperCase());

export function summarise(orders: Order[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const item of orders) {
    summary[item.id] = totalOf(item, true);
    summary[item.customer] = tokens.length;
  }
  return summery;
}

console.log(saved, missing, order.lines[0].price);
