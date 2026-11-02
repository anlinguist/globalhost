/**
 * One structured JSON line per event on stdout (Cloud Logging reads `severity` and
 * `message`). Callers pass reason codes and small scalars only: never a token, a
 * header value, or anything else a client controls beyond the method.
 */

export type Severity = "DEBUG" | "INFO" | "WARNING" | "ERROR";
export type LogFields = Record<string, string | number | boolean | undefined>;
export type Logger = (severity: Severity, message: string, fields?: LogFields) => void;

export const jsonLogger: Logger = (severity, message, fields) => {
  process.stdout.write(`${JSON.stringify({ severity, message, component: "access-guard", ...fields })}\n`);
};

export const silentLogger: Logger = () => {};
