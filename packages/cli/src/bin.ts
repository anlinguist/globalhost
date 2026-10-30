#!/usr/bin/env node
import { run } from "./main.js";
import { runCommand } from "./run-command.js";

const argv = process.argv.slice(2);
if (argv[0] === "run" || argv[0] === "roles") {
  // Long-running and streamed, so these commands write as they go instead of returning a CliResult.
  process.exitCode = await runCommand(argv, {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    env: process.env,
    cwd: process.cwd(),
  });
} else {
  const result = run(argv);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
