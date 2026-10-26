#!/usr/bin/env node
import { basename } from "node:path";
import { createProgram } from "./cli/program.js";

const program = createProgram();

function isDirectRun(): boolean {
  if (!process.argv[1]) return false;
  const arg1 = process.argv[1];
  return (
    arg1.endsWith("cli.js") ||
    arg1.endsWith("cli.ts") ||
    arg1.endsWith("/prism") ||
    arg1 === "prism" ||
    basename(arg1) === "prism"
  );
}

if (isDirectRun()) {
  program.parseAsync().catch((err: any) => {
    // Print clean error message without stack trace for known errors
    const message = err?.message || String(err);
    console.error(`error: ${message}`);
    process.exit(1);
  });
}

export { program, createProgram };
