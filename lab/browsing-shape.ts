// The browsing shape: an agent that works a website through page snapshots.
//
// Each step the agent calls a browser tool and gets the page back as a text
// snapshot — an accessibility tree with an element ref per line, the format
// Playwright MCP and vercel-labs/agent-browser both emit. A snapshot is a few
// thousand tokens; the agent takes one per step; all of them stay in the
// transcript and are re-sent on every later turn.
//
// This harness answers one question: where is the money on that shape, and how
// much of it can Mesh reach from the proxy, without the customer changing their
// browser tool? It compares:
//
//   raw          no Mesh, no cache (Anthropic's cache is opt-in)
//   defaults     Mesh as `mesh start` runs it: lossless levers, no cache flag
//   today        Mesh's lossless stack WITH the cache flag (set by the caller
//                or a Theo policy) — the most the product does today
//   freshCap     today + the generic fresh tool-result cap (a warning arm)
//   atSource     the agent-browser idea: interactive-only snapshots at the
//                source (the customer swaps tools), then `today`
//   lineDedup    today + content-preserving stale-snapshot line dedup
//   supersede    today + stale snapshots replaced by a stub
//   both         atSource + supersede — the two are complementary
//
// Basis: SIMULATOR, on a SYNTHETIC session. Page sizes, the step script and the
// session length are ESTIMATES chosen to look like a shop checkout; real pages
// are often several times larger, which makes the stale-snapshot share bigger,
// not smaller. No grader runs here: the lossy arms report what the model can
// no longer read, and rest at needs_gate.

import { approximateTokenCount } from "../packages/core/src/token-reduction.js";
import { CachePrefixVolatilityGuard } from "../packages/sdk-js/src/cache-volatility-guard.js";
import { reduceRequest, type MeshTokenReductionConfig } from "../packages/sdk-js/src/reduce-request.js";
import {
  dedupeStaleSnapshotLines,
  isPageSnapshot,
  moveBreakpointBeforeFreshSnapshot,
  supersedeStaleSnapshots,
} from "./experiments/page-snapshots.js";

type AnyObject = Record<string, unknown>;

export const BROWSING_MODEL = "claude-sonnet-5-5";

/** Sonnet-class output costs five times input per token (published rates). */
const OUTPUT_MULTIPLIER = 5;
const WRITE_MULTIPLIER = 1.25;
const READ_MULTIPLIER = 0.1;
const MINIMUM_CACHEABLE_TOKENS = 1024;

// ---------------------------------------------------------------------------
// Synthetic pages
// ---------------------------------------------------------------------------

type Line = { indent: number; role: string; name?: string; extra?: string; text?: string };

const INTERACTIVE = new Set(["link", "button", "textbox", "combobox", "checkbox", "radio", "spinbutton", "searchbox"]);

const el = (indent: number, role: string, name?: string, extra?: string): Line => ({ indent, role, name, extra });
const txt = (indent: number, text: string): Line => ({ indent, role: "text", text });

const DEPARTMENTS = [
  "Kitchen", "Dining", "Bedroom", "Bathroom", "Lighting", "Storage", "Garden",
  "Cleaning", "Heating", "Electricals", "Furniture", "Textiles", "Decor", "Clearance",
];
const FOOTER_LINKS = [
  "Help centre", "Delivery information", "Returns and refunds", "Track an order", "Click and collect",
  "Store finder", "Gift cards", "Price promise", "Product recalls", "Recycling", "Trade accounts",
  "Careers", "About us", "Press", "Sustainability", "Modern slavery statement", "Accessibility",
  "Privacy notice", "Cookie settings", "Terms and conditions", "Contact us", "Student discount",
  "Affiliates", "Site map",
];
const KINDS = ["kettle", "toaster", "desk lamp", "storage box"];
const BRANDS = ["Aldergrove", "Brightwell", "Castleton", "Dunmore", "Elmhurst", "Fairholt"];
const VARIANTS = ["Classic", "Compact", "Slimline", "Family", "Studio", "Travel"];

type Product = { name: string; price: string; rating: string; id: string };

function products(kind: string, count: number): Product[] {
  return Array.from({ length: count }, (_unused, i) => {
    const pounds = 14 + ((i * 7 + kind.length * 3) % 43);
    return {
      id: `${kind.replace(/ /g, "-")}-${i + 1}`,
      name: `${BRANDS[i % BRANDS.length]} ${VARIANTS[(i * 5 + 1) % VARIANTS.length]} ${kind} ${100 + i * 15}`,
      price: `£${pounds}.${i % 2 === 0 ? "99" : "50"}`,
      rating: `${(3.6 + ((i * 3) % 14) / 10).toFixed(1)} out of 5 (${40 + i * 17} reviews)`,
    };
  });
}

function header(basketCount: number): Line[] {
  return [
    el(0, "banner"),
    el(1, "link", "Northgate Home — home"),
    el(1, "search"),
    el(2, "searchbox", "Search products"),
    el(2, "button", "Search"),
    el(1, "navigation", "Departments"),
    ...DEPARTMENTS.map((department) => el(2, "link", department)),
    el(1, "link", "Account"),
    el(1, "link", `Basket (${basketCount} item${basketCount === 1 ? "" : "s"})`),
  ];
}

function footer(): Line[] {
  return [
    el(0, "contentinfo"),
    el(1, "navigation", "Footer"),
    ...FOOTER_LINKS.map((link) => el(2, "link", link)),
    el(1, "textbox", "Email address for offers"),
    el(1, "button", "Sign up"),
    txt(1, "Northgate Home Ltd. Prices include VAT. Delivery charges apply to orders under £40."),
    txt(1, "Images are for illustration. Colours may vary by screen."),
  ];
}

function homeMain(): Line[] {
  const featured = products("kettle", 6).concat(products("desk lamp", 6));
  return [
    el(0, "main"),
    el(1, "heading", "Everything for the home", "[level=1]"),
    txt(1, "Free delivery on orders over £40. Thirty-day returns on everything."),
    el(1, "list", "Featured this week"),
    ...featured.flatMap((p) => [
      el(2, "listitem"),
      el(3, "link", p.name),
      txt(3, p.price),
      el(3, "button", `Add ${p.name} to basket`),
    ]),
  ];
}

function resultsMain(kind: string, filtered: boolean, sortedByRating: boolean): Line[] {
  let list = products(kind, 24);
  if (filtered) list = list.filter((p) => Number(p.price.slice(1)) < 30);
  if (sortedByRating) list = [...list].sort((a, b) => b.rating.localeCompare(a.rating) || a.id.localeCompare(b.id));
  return [
    el(0, "main"),
    el(1, "heading", `Results for "${kind}"`, "[level=1]"),
    txt(1, `${list.length} products`),
    el(1, "combobox", "Sort by", sortedByRating ? ": Customer rating" : ": Relevance"),
    el(1, "group", "Filters"),
    el(2, "checkbox", "Under £30", filtered ? "[checked]" : undefined),
    ...["£30 to £50", "In stock", "Next-day delivery", "On offer", "Four stars and up", "Energy rating A"].map(
      (filter) => el(2, "checkbox", filter),
    ),
    el(1, "list", "Products"),
    ...list.flatMap((p) => [
      el(2, "listitem"),
      el(3, "link", p.name),
      txt(3, p.price),
      txt(3, p.rating),
      el(3, "button", `Add ${p.name} to basket`),
    ]),
  ];
}

function productMain(kind: string, colour: string, added: boolean): Line[] {
  const p = products(kind, 24)[2]!;
  const specs = [
    ["Capacity", "1.7 litres"], ["Power", "3000 W"], ["Material", "Brushed steel"], ["Cord length", "0.75 m"],
    ["Weight", "1.1 kg"], ["Height", "24 cm"], ["Width", "16 cm"], ["Depth", "22 cm"], ["Warranty", "2 years"],
    ["Filter", "Removable, washable"], ["Boil-dry protection", "Yes"], ["Model number", `NG-${p.id.toUpperCase()}`],
  ];
  return [
    el(0, "main"),
    el(1, "heading", p.name, "[level=1]"),
    el(1, "img", `${p.name}, front view`),
    txt(1, p.price),
    txt(1, p.rating),
    txt(1, "In stock. Order before 8pm for next-day delivery."),
    txt(1, "A quiet-boil element, a wide spout that pours without dripping, and a base that turns all the way round."),
    el(1, "radiogroup", "Colour"),
    ...["Steel", "Black", "Cream", "Sage"].map((c) => el(2, "radio", c, c === colour ? "[checked]" : undefined)),
    el(1, "spinbutton", "Quantity", ": 1"),
    el(1, "button", "Add to basket"),
    ...(added ? [el(1, "alert"), txt(2, `${p.name} (${colour}) added to your basket.`)] : []),
    el(1, "table", "Specification"),
    ...specs.map(([key, value]) => el(2, "row", `${key} ${value}`)),
    el(1, "list", "Reviews"),
    ...Array.from({ length: 8 }, (_unused, i) => [
      el(2, "listitem"),
      txt(3, `Review ${i + 1}: ${["Boils fast and pours cleanly.", "Good value, feels solid.", "Lid is a little stiff at first.", "Quieter than my last one."][i % 4]}`),
    ]).flat(),
  ];
}

function basketMain(kind: string, colour: string): Line[] {
  const p = products(kind, 24)[2]!;
  return [
    el(0, "main"),
    el(1, "heading", "Your basket", "[level=1]"),
    el(1, "table", "Basket items"),
    el(2, "row", `${p.name} (${colour})`),
    el(3, "link", p.name),
    el(3, "spinbutton", `Quantity of ${p.name}`, ": 1"),
    txt(3, p.price),
    el(3, "button", `Remove ${p.name}`),
    txt(1, `Subtotal ${p.price}`),
    txt(1, "Delivery £3.95"),
    txt(1, `Order total £${(Number(p.price.slice(1)) + 3.95).toFixed(2)}`),
    el(1, "textbox", "Discount code"),
    el(1, "button", "Apply code"),
    el(1, "button", "Go to checkout"),
    el(1, "link", "Continue shopping"),
  ];
}

const ADDRESS_FIELDS = [
  "First name", "Last name", "Email", "Phone", "Address line 1", "Address line 2", "Town or city",
  "County", "Postcode", "Delivery instructions", "Card number", "Name on card", "Expiry month",
  "Expiry year", "Security code", "Billing postcode",
];

function checkoutMain(kind: string, filled: number, delivery: string): Line[] {
  const p = products(kind, 24)[2]!;
  return [
    el(0, "main"),
    el(1, "heading", "Checkout", "[level=1]"),
    el(1, "form", "Delivery and payment"),
    ...ADDRESS_FIELDS.map((field, i) => el(2, "textbox", field, i < filled ? ": (entered)" : undefined)),
    el(2, "radiogroup", "Delivery option"),
    ...["Standard, 3 to 5 days, £3.95", "Next day, £5.95", "Collect in store, free"].map((option) =>
      el(3, "radio", option, option.startsWith(delivery) ? "[checked]" : undefined),
    ),
    el(2, "checkbox", "Use delivery address for billing", "[checked]"),
    el(2, "checkbox", "Email me offers"),
    txt(1, `Order summary: ${p.name}, quantity 1, ${p.price}`),
    txt(1, delivery === "Next day" ? "Delivery £5.95" : "Delivery £3.95"),
    el(1, "button", "Place order"),
  ];
}

function confirmationMain(kind: string, cycle: number): Line[] {
  const p = products(kind, 24)[2]!;
  return [
    el(0, "main"),
    el(1, "heading", "Thank you — your order is placed", "[level=1]"),
    txt(1, `Order number NG-${48213 + cycle * 97}`),
    txt(1, `${p.name}, quantity 1, ${p.price}`),
    txt(1, "Estimated delivery: tomorrow before 6pm."),
    txt(1, "A confirmation email is on its way."),
    el(1, "link", "View order"),
    el(1, "link", "Continue shopping"),
  ];
}

type Step = { note: string; tool: string; input: AnyObject; url: string; title: string; main: Line[]; basket: number };

const STEPS_PER_CYCLE = 12;

function step(index: number): Step {
  const cycle = Math.floor(index / STEPS_PER_CYCLE);
  const kind = KINDS[cycle % KINDS.length]!;
  const base = "https://shop.northgate.example";
  const q = encodeURIComponent(kind);
  const basket = cycle; // one item added per completed cycle
  switch (index % STEPS_PER_CYCLE) {
    case 0:
      return { note: "Opening the shop's home page.", tool: "browser_navigate", input: { url: base }, url: `${base}/`, title: "Northgate Home", main: homeMain(), basket };
    case 1:
      return { note: `Searching for "${kind}".`, tool: "browser_type", input: { element: "Search products", text: kind, submit: true }, url: `${base}/search?q=${q}`, title: `Results for ${kind}`, main: resultsMain(kind, false, false), basket };
    case 2:
      return { note: "Narrowing to items under £30.", tool: "browser_click", input: { element: "Under £30" }, url: `${base}/search?q=${q}&max=30`, title: `Results for ${kind}`, main: resultsMain(kind, true, false), basket };
    case 3:
      return { note: "Sorting by customer rating.", tool: "browser_select_option", input: { element: "Sort by", values: ["Customer rating"] }, url: `${base}/search?q=${q}&max=30&sort=rating`, title: `Results for ${kind}`, main: resultsMain(kind, true, true), basket };
    case 4:
      return { note: "Opening the best match to check its details.", tool: "browser_click", input: { element: products(kind, 24)[2]!.name }, url: `${base}/p/${products(kind, 24)[2]!.id}`, title: products(kind, 24)[2]!.name, main: productMain(kind, "Steel", false), basket };
    case 5:
      return { note: "Choosing the Sage colour.", tool: "browser_click", input: { element: "Sage" }, url: `${base}/p/${products(kind, 24)[2]!.id}?colour=sage`, title: products(kind, 24)[2]!.name, main: productMain(kind, "Sage", false), basket };
    case 6:
      return { note: "Adding it to the basket.", tool: "browser_click", input: { element: "Add to basket" }, url: `${base}/p/${products(kind, 24)[2]!.id}?colour=sage`, title: products(kind, 24)[2]!.name, main: productMain(kind, "Sage", true), basket: basket + 1 };
    case 7:
      return { note: "Opening the basket to check the total.", tool: "browser_click", input: { element: "Basket" }, url: `${base}/basket`, title: "Your basket", main: basketMain(kind, "Sage"), basket: basket + 1 };
    case 8:
      return { note: "Going to checkout.", tool: "browser_click", input: { element: "Go to checkout" }, url: `${base}/checkout`, title: "Checkout", main: checkoutMain(kind, 0, "Standard"), basket: basket + 1 };
    case 9:
      return { note: "Filling in the delivery address.", tool: "browser_fill_form", input: { fields: ADDRESS_FIELDS.slice(0, 10) }, url: `${base}/checkout`, title: "Checkout", main: checkoutMain(kind, 10, "Standard"), basket: basket + 1 };
    case 10:
      return { note: "Choosing next-day delivery.", tool: "browser_click", input: { element: "Next day, £5.95" }, url: `${base}/checkout`, title: "Checkout", main: checkoutMain(kind, 10, "Next day"), basket: basket + 1 };
    default:
      return { note: "Placing the order.", tool: "browser_click", input: { element: "Place order" }, url: `${base}/order/confirmed`, title: "Order confirmed", main: confirmationMain(kind, cycle), basket: basket + 1 };
  }
}

export type SnapshotStyle = {
  /**
   * true: an element keeps its ref for as long as it survives (agent-browser's
   * documented behaviour). false: refs are renumbered in document order on
   * every snapshot.
   */
  stableRefs: boolean;
  /** The agent-browser idea at the source: interactive elements only, flat. */
  interactiveOnly: boolean;
};

function renderSnapshot(current: Step, style: SnapshotStyle, registry: Map<string, number>): string {
  const lines = [...header(current.basket), ...current.main, ...footer()];
  let counter = 0;
  const path: string[] = [];
  const out: string[] = [`- Page URL: ${current.url}`, `- Page Title: ${current.title}`, "- Page Snapshot:"];
  for (const line of lines) {
    path.length = line.indent;
    path[line.indent] = `${line.role}:${line.name ?? ""}`;
    if (line.role === "text") {
      if (!style.interactiveOnly) out.push(`${"  ".repeat(line.indent + 1)}- text: ${line.text}`);
      continue;
    }
    counter += 1;
    let ref = counter;
    if (style.stableRefs) {
      const identity = path.slice(0, line.indent + 1).join(">");
      if (!registry.has(identity)) registry.set(identity, registry.size + 1);
      ref = registry.get(identity)!;
    }
    const name = line.name !== undefined ? ` "${line.name}"` : "";
    if (style.interactiveOnly) {
      if (INTERACTIVE.has(line.role)) out.push(`@e${ref} [${line.role}]${name}${line.extra ? ` ${line.extra.replace(/^: /, "value=")}` : ""}`);
      continue;
    }
    const extra = line.extra === undefined ? "" : line.extra.startsWith(":") ? "" : ` ${line.extra}`;
    const value = line.extra?.startsWith(":") ? line.extra : "";
    out.push(`${"  ".repeat(line.indent + 1)}- ${line.role}${name}${extra} [ref=e${ref}]${value}`);
  }
  return out.join("\n");
}

const PREAMBLE = [
  "You are a careful web agent. You operate a browser through the tools provided and complete the user's task end to end.",
  ...Array.from({ length: 34 }, (_unused, i) =>
    `Rule ${i + 1}: ${[
      "act only on elements present in the most recent page snapshot, addressing each by its ref",
      "take a new snapshot after any action that could change the page before acting again",
      "never enter payment details that the user has not supplied in this conversation",
      "prefer the site's own search and filters over guessing a URL",
      "stop and ask when a page asks for a choice the task does not cover",
      "report prices, totals and order numbers exactly as the page shows them",
    ][i % 6]}; this applies on every site and in every step of the task, variant ${i + 1}.`,
  ),
].join("\n");

const TOOLS = [
  ["browser_navigate", "Navigate the current tab to a URL and return a snapshot of the page that loads.", { url: { type: "string", description: "Absolute URL to open." } }],
  ["browser_snapshot", "Return a text snapshot of the current page: its accessibility tree with a ref per element.", {}],
  ["browser_click", "Click an element identified by its ref from the latest snapshot.", { element: { type: "string", description: "Human-readable element description." }, ref: { type: "string", description: "Element ref from the snapshot." } }],
  ["browser_type", "Type text into an editable element; optionally submit with Enter.", { element: { type: "string" }, ref: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" } }],
  ["browser_fill_form", "Fill several form fields in one call.", { fields: { type: "array", items: { type: "string" }, description: "Field names to fill." } }],
  ["browser_select_option", "Select one or more options in a dropdown.", { element: { type: "string" }, ref: { type: "string" }, values: { type: "array", items: { type: "string" } } }],
  ["browser_press_key", "Press a key on the keyboard.", { key: { type: "string", description: "Key name, such as ArrowDown or Enter." } }],
  ["browser_wait_for", "Wait for text to appear or disappear, or for a number of seconds.", { text: { type: "string" }, time: { type: "number" } }],
  ["browser_navigate_back", "Go back to the previous page.", {}],
].map(([name, description, properties]) => ({
  name,
  description,
  input_schema: { type: "object", properties, additionalProperties: false },
}));

export type BrowsingSession = {
  /** Request k is what the agent sends for its k-th decision. */
  requests: AnyObject[];
  /** Tokens the model generates in answer to request k. */
  outputTokens: number[];
  snapshotTokens: number[];
};

/** A deterministic browsing session of `steps` page snapshots. */
export function browsingSession(steps: number, style: Partial<SnapshotStyle> = {}): BrowsingSession {
  const resolved: SnapshotStyle = { stableRefs: true, interactiveOnly: false, ...style };
  const registry = new Map<string, number>();
  const task = { role: "user", content: "Buy the best-rated option under £30 in Sage, with next-day delivery, and tell me the order number and the total." };
  const history: AnyObject[] = [task];
  const requests: AnyObject[] = [];
  const outputTokens: number[] = [];
  const snapshotTokens: number[] = [];
  const request = (): AnyObject => ({
    model: BROWSING_MODEL,
    max_tokens: 1024,
    system: PREAMBLE,
    tools: TOOLS,
    messages: history.map((message) => ({ ...message })),
  });
  for (let index = 0; index < steps; index += 1) {
    const current = step(index);
    requests.push(request());
    const assistant = {
      role: "assistant",
      content: [
        { type: "text", text: current.note },
        { type: "tool_use", id: `toolu_${String(index).padStart(3, "0")}`, name: current.tool, input: current.input },
      ],
    };
    outputTokens.push(approximateTokenCount(JSON.stringify(assistant.content)));
    const snapshot = renderSnapshot(current, resolved, registry);
    snapshotTokens.push(approximateTokenCount(snapshot));
    history.push(assistant, {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: assistant.content[1]!.id, content: snapshot }],
    });
  }
  requests.push(request());
  outputTokens.push(approximateTokenCount("The order is placed. Order number NG-48213; the total was £32.94 including next-day delivery."));
  return { requests, outputTokens, snapshotTokens };
}

// ---------------------------------------------------------------------------
// Pricing: explicit breakpoints
// ---------------------------------------------------------------------------

const stripMarker = (value: unknown): string =>
  JSON.stringify(value ?? null, (key, inner) => (key === "cache_control" ? undefined : inner));

/** The prompt in provider order, and the offset of every breakpoint in it. */
function layout(request: AnyObject): { content: string; breakpoints: number[] } {
  let content = stripMarker(request.tools ?? []);
  const breakpoints: number[] = [];
  const add = (text: string, marked: boolean): void => {
    content += `\n${text}`;
    if (marked) breakpoints.push(content.length);
  };
  const blocks = (owner: string, value: unknown): void => {
    if (typeof value === "string") {
      add(`${owner}:${value}`, false);
      return;
    }
    if (!Array.isArray(value)) return;
    for (const block of value) {
      const marked = typeof block === "object" && block !== null && "cache_control" in block;
      add(`${owner}:${stripMarker(block)}`, marked);
    }
  };
  blocks("system", request.system);
  for (const message of (request.messages as AnyObject[] | undefined) ?? []) blocks(String(message.role), message.content);
  return { content, breakpoints };
}

export type PricedBrowsing = {
  /** Token-equivalents at the base input rate. */
  inputCost: number;
  outputCost: number;
  cost: number;
  inputTokens: number;
  readTokens: number;
  writeTokens: number;
};

/**
 * Price a session under Anthropic's documented cache rules with EXPLICIT
 * breakpoints: an entry exists only where a breakpoint was placed; a request
 * reads the longest earlier entry its prompt starts with (at or before its own
 * last breakpoint), writes from there to its last breakpoint at 1.25x, and pays
 * the rest at the plain rate. Requests are seconds apart, so nothing expires.
 */
export function priceBrowsing(requests: AnyObject[], outputTokens: number[]): PricedBrowsing {
  const written: string[] = [];
  const priced: PricedBrowsing = { inputCost: 0, outputCost: 0, cost: 0, inputTokens: 0, readTokens: 0, writeTokens: 0 };
  requests.forEach((request, index) => {
    const { content, breakpoints } = layout(request);
    const total = approximateTokenCount(content);
    const lastBreakpoint = breakpoints.length > 0 ? Math.max(...breakpoints) : 0;
    let readChars = 0;
    for (const prior of written) {
      if (prior.length <= lastBreakpoint && prior.length > readChars && content.startsWith(prior)) readChars = prior.length;
    }
    const read = approximateTokenCount(content.slice(0, readChars));
    const write = lastBreakpoint > readChars ? approximateTokenCount(content.slice(readChars, lastBreakpoint)) : 0;
    const fresh = Math.max(0, total - read - write);
    priced.inputTokens += total;
    priced.readTokens += read;
    priced.writeTokens += write;
    priced.inputCost += read * READ_MULTIPLIER + write * WRITE_MULTIPLIER + fresh;
    priced.outputCost += (outputTokens[index] ?? 0) * OUTPUT_MULTIPLIER;
    for (const offset of breakpoints) {
      const prefix = content.slice(0, offset);
      if (approximateTokenCount(prefix) >= MINIMUM_CACHEABLE_TOKENS && !written.includes(prefix)) written.push(prefix);
    }
  });
  priced.cost = priced.inputCost + priced.outputCost;
  return priced;
}

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

const TODAY: MeshTokenReductionConfig = { toolSchemas: true, duplicateContext: true, repairCachePrefix: true, cacheTtl: "5m" };

type ArmSpec = {
  id: string;
  label: string;
  /** False when the model is sent different content from the raw session. */
  lossless: boolean;
  needsCustomerChange: boolean;
  style?: Partial<SnapshotStyle>;
  config?: MeshTokenReductionConfig;
  transform?: (request: AnyObject) => AnyObject;
  moveBreakpoint?: boolean;
};

const ARMS: ArmSpec[] = [
  { id: "raw", label: "No Mesh, no cache", lossless: true, needsCustomerChange: false },
  { id: "defaults", label: "Mesh defaults: lossless levers, no cache flag", lossless: true, needsCustomerChange: false, config: { toolSchemas: true, duplicateContext: true, repairCachePrefix: true } },
  { id: "today", label: "Mesh today: lossless stack + cache flag", lossless: true, needsCustomerChange: false, config: TODAY },
  { id: "freshCap", label: "today + generic fresh tool-result cap (600 tokens)", lossless: false, needsCustomerChange: false, config: { ...TODAY, freshToolResultCap: true } },
  { id: "atSource", label: "agent-browser idea: interactive-only snapshots at the source", lossless: false, needsCustomerChange: true, style: { interactiveOnly: true }, config: TODAY },
  { id: "lineDedup", label: "Mesh: stale-snapshot line dedup (content-preserving)", lossless: false, needsCustomerChange: false, config: TODAY, transform: dedupeStaleSnapshotLines, moveBreakpoint: true },
  { id: "supersede", label: "Mesh: stale snapshots superseded", lossless: false, needsCustomerChange: false, config: TODAY, transform: supersedeStaleSnapshots, moveBreakpoint: true },
  { id: "both", label: "interactive-only at the source + Mesh supersession", lossless: false, needsCustomerChange: true, style: { interactiveOnly: true }, config: TODAY, transform: supersedeStaleSnapshots, moveBreakpoint: true },
];

function send(spec: ArmSpec, session: BrowsingSession): AnyObject[] {
  const guard = new CachePrefixVolatilityGuard();
  return session.requests.map((raw) => {
    const shaped = spec.transform ? spec.transform(raw) : raw;
    if (!spec.config) return shaped;
    // In the product the guard reads the CLIENT's raw request, so Mesh's own
    // rewrite of an older snapshot is never mistaken for the client rewriting
    // its history. The lab applies the rewrite before the reducer, so it hands
    // the guard the raw request explicitly.
    const config: MeshTokenReductionConfig = spec.config.cacheTtl === undefined
      ? spec.config
      : { ...spec.config, cacheVolatilityGuard: { observe: (_shaped, context) => guard.observe(raw, context) } };
    const reduced = reduceRequest(shaped, config).request as AnyObject;
    return spec.moveBreakpoint ? moveBreakpointBeforeFreshSnapshot(reduced) : reduced;
  });
}

const resultTexts = (request: AnyObject): string[] =>
  ((request.messages as AnyObject[] | undefined) ?? []).flatMap((message) =>
    Array.isArray(message.content)
      ? (message.content as AnyObject[])
          .filter((block) => block.type === "tool_result" && typeof block.content === "string")
          .map((block) => block.content as string)
      : [],
  );

/** Distinct static text lines the full (un-pruned) session showed the model. */
function staticFacts(session: BrowsingSession): string[] {
  const facts = new Set<string>();
  for (const text of resultTexts(session.requests.at(-1)!)) {
    for (const line of text.split("\n")) {
      const match = /^\s*- text: (.+)$/.exec(line);
      if (match) facts.add(match[1]!);
    }
  }
  return [...facts];
}

export type BrowsingArm = {
  id: string;
  label: string;
  lossless: boolean;
  needsCustomerChange: boolean;
  priced: PricedBrowsing;
  /** Whole-bill saving against the raw, uncached session. */
  savingVsRawPercent: number;
  /** Whole-bill saving against what Mesh does today. */
  savingVsTodayPercent: number;
  /** Static page text (prices, totals, order numbers…) still readable in the final request. */
  factsReadable: number;
  factsTotal: number;
  /** Newest snapshots that reached the model altered (it must act on these). */
  freshPagesAltered: number;
};

export type BrowsingResult = {
  steps: number;
  stableRefs: boolean;
  averageSnapshotTokens: number;
  /** Share of the raw input bill that is OLD snapshots being re-sent. */
  staleSnapshotShareOfRawInput: number;
  arms: BrowsingArm[];
};

const cache = new Map<string, BrowsingResult>();

/** Run every arm on a `steps`-snapshot session. Deterministic, so memoised. */
export function qualifyBrowsingShape(options: { steps?: number; stableRefs?: boolean } = {}): BrowsingResult {
  const steps = options.steps ?? 12;
  const stableRefs = options.stableRefs ?? true;
  const key = `${steps}:${stableRefs}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const full = browsingSession(steps, { stableRefs });
  const facts = staticFacts(full);
  const rawPriced = priceBrowsing(full.requests, full.outputTokens);

  const runs = ARMS.map((spec) => {
    const session = spec.style ? browsingSession(steps, { stableRefs, ...spec.style }) : full;
    const sent = send(spec, session);
    const priced = priceBrowsing(sent, session.outputTokens);
    const finalText = resultTexts(sent.at(-1)!).join("\n");
    let freshPagesAltered = 0;
    sent.forEach((request, index) => {
      const before = resultTexts(session.requests[index]!).at(-1);
      const after = resultTexts(request).at(-1);
      if (before !== undefined && isPageSnapshot(before) && before !== after) freshPagesAltered += 1;
    });
    return { spec, priced, factsReadable: facts.filter((fact) => finalText.includes(fact)).length, freshPagesAltered };
  });
  const today = runs.find((run) => run.spec.id === "today")!.priced.cost;

  // Old snapshots re-sent: every snapshot is paid once when fresh and again on each later turn.
  const staleResent = full.snapshotTokens.reduce((sum, tokens, index) => sum + tokens * (steps - 1 - index), 0);

  const result: BrowsingResult = {
    steps,
    stableRefs,
    averageSnapshotTokens: full.snapshotTokens.reduce((a, b) => a + b, 0) / steps,
    staleSnapshotShareOfRawInput: staleResent / rawPriced.inputTokens,
    arms: runs.map(({ spec, priced, factsReadable, freshPagesAltered }) => ({
      id: spec.id,
      label: spec.label,
      lossless: spec.lossless,
      needsCustomerChange: spec.needsCustomerChange,
      priced,
      savingVsRawPercent: ((rawPriced.cost - priced.cost) / rawPriced.cost) * 100,
      savingVsTodayPercent: ((today - priced.cost) / today) * 100,
      factsReadable,
      factsTotal: facts.length,
      freshPagesAltered,
    })),
  };
  cache.set(key, result);
  return result;
}

export const browsingArm = (result: BrowsingResult, id: string): BrowsingArm =>
  result.arms.find((arm) => arm.id === id)!;
