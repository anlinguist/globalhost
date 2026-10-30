#!/usr/bin/env node
import { run } from "./main.js";
import { assessCommand } from "./assess-command.js";
import { dispatchCommand } from "./dispatch-command.js";
import { runCommand } from "./run-command.js";

const argv = process.argv.slice(2);

/**
 * Exit once output is flushed. The long-running commands leave sockets behind (the Managed Agents event stream,
 * keep-alive agents), and without an explicit exit a finished dispatch idles until the Actions job times out.
 */
function finish(code: number): void {
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
}

if (argv[0] === "dispatch") {
  finish(await dispatchCommand(argv, process.env, (t) => process.stderr.write(t)));
} else if (argv[0] === "assess") {
  finish(await assessCommand(argv, {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    env: process.env,
    cwd: process.cwd(),
  }));
} else if (argv[0] === "run" || argv[0] === "roles") {
  // Long-running and streamed, so these commands write as they go instead of returning a CliResult.
  finish(await runCommand(argv, {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    env: process.env,
    cwd: process.cwd(),
  }));
} else {
  const result = run(argv);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
