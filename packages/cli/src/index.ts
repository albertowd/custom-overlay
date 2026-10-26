#!/usr/bin/env node
import { createProgram } from './program.js';

createProgram()
  .parseAsync()
  .catch((error: unknown) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
