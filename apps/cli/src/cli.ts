#!/usr/bin/env node
/**
 * cli.ts — `mstack`, the offline demo driver (research/06-architecture.md §5.2,
 * §7 W5-T3). Parses argv with node:util `parseArgs` (no heavy dep), opens one
 * shared `MemoryRepo` per command (single-writer discipline), prints the mode,
 * dispatches, and always closes the warehouse.
 *
 * ACCEPTANCE: `mstack seed && mstack demo` runs offline with no credentials,
 * prints reviews + decisions + drafts, dispatches nothing, and exits 0.
 */
import { parseArgs } from "node:util";

import type { CliContext, ContextOverrides } from "./context.js";
import { openContext } from "./context.js";
import { runSeed } from "./seed.js";
import { runDemo } from "./demo.js";
import { runApprove, runList, runReviewFile, runScoreDomain } from "./commands.js";
import { printDemoResult, printHelp, printModeBanner, printSeedResult } from "./format.js";

/** Run `fn` inside an opened context, printing the mode banner first and always
 *  closing the warehouse afterward (single-writer discipline). */
async function withContext(overrides: ContextOverrides, fn: (ctx: CliContext) => Promise<void>): Promise<void> {
  const ctx = await openContext(overrides);
  printModeBanner(ctx.mode);
  try {
    await fn(ctx);
  } finally {
    await ctx.memory.close();
  }
}

function requireArg(value: string | undefined, name: string): string {
  if (!value || value.length === 0) {
    throw new Error(`missing required argument <${name}>. Try: mstack help`);
  }
  return value;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      "drafts-dir": { type: "string" },
      "outbox-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  const command = positionals[0] ?? "help";
  if (values.help === true || command === "help") {
    printHelp();
    return 0;
  }

  const overrides: ContextOverrides = {
    dataDir: values["data-dir"],
    draftsDir: values["drafts-dir"],
    outboxDir: values["outbox-dir"],
  };

  switch (command) {
    case "seed":
      await withContext(overrides, async (ctx) => printSeedResult(await runSeed(ctx)));
      return 0;

    case "demo":
      await withContext(overrides, async (ctx) => printDemoResult(await runDemo(ctx)));
      return 0;

    case "list":
      await withContext(overrides, (ctx) => runList(ctx));
      return 0;

    case "approve":
      await withContext(overrides, (ctx) => runApprove(ctx, requireArg(positionals[1], "draftId")));
      return 0;

    case "review":
      await withContext(overrides, (ctx) => runReviewFile(ctx, requireArg(positionals[1], "file")));
      return 0;

    case "score":
      await withContext(overrides, (ctx) => runScoreDomain(ctx, requireArg(positionals[1], "domain")));
      return 0;

    default:
      console.error(`mstack: unknown command "${command}"\n`);
      printHelp();
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
    // Safety net: if a native DB handle (DuckDB / LanceDB) keeps the event loop
    // alive after all work is done, force a clean exit. Unref'd, so it NEVER
    // delays a clean natural exit or truncates buffered stdout in the normal case.
    setTimeout(() => process.exit(code), 500).unref();
  })
  .catch((err: unknown) => {
    console.error(`\nmstack: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
