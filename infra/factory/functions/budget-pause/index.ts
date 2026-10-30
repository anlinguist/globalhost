// Cloud Function (2nd gen, Pub/Sub trigger): a budget notification at >= 100% sets `paused: true`
// in gs://<CONTROL_BUCKET>/<STATE_OBJECT>. It never un-pauses; the owner resumes (`globalhost resume`).
// GCS is reached through its JSON API with the function's own token from the metadata server, so
// the only runtime dependency is the Functions Framework.
import { cloudEvent, type CloudEvent } from "@google-cloud/functions-framework";
import { applyBudgetNotification, parseBudgetNotification, type ControlStore } from "./pause.js";

interface PubSubEventData {
  message?: { data?: unknown };
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

function log(severity: "INFO" | "WARNING" | "ERROR", message: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ severity, message, ...fields }));
}

async function accessToken(): Promise<string> {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!res.ok) throw new Error(`metadata token: HTTP ${res.status}`);
  const body = (await res.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string") throw new Error("metadata token: no access_token");
  return body.access_token;
}

export function gcsControlStore(bucket: string, object: string): ControlStore {
  const b = encodeURIComponent(bucket);
  const o = encodeURIComponent(object);
  return {
    async read() {
      const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${b}/o/${o}?alt=media`, {
        headers: { Authorization: `Bearer ${await accessToken()}` },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`read ${object}: HTTP ${res.status}`);
      const generation = res.headers.get("x-goog-generation");
      if (!generation) throw new Error(`read ${object}: no generation header`);
      return { body: await res.text(), generation };
    },
    async write(body, ifGenerationMatch) {
      const url =
        `https://storage.googleapis.com/upload/storage/v1/b/${b}/o?uploadType=media` +
        `&name=${o}&ifGenerationMatch=${encodeURIComponent(ifGenerationMatch)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
        body,
      });
      if (res.status === 412) return "conflict";
      if (!res.ok) throw new Error(`write ${object}: HTTP ${res.status}`);
      return "ok";
    },
  };
}

cloudEvent<PubSubEventData>("budgetPause", async (event: CloudEvent<PubSubEventData>) => {
  const notification = parseBudgetNotification(event.data?.message?.data);
  const store = gcsControlStore(env("CONTROL_BUCKET"), process.env.STATE_OBJECT ?? "state.json");
  const outcome = await applyBudgetNotification(store, notification, {
    expectedBudgetName: env("BUDGET_DISPLAY_NAME"),
    now: new Date(),
  });
  log(outcome === "paused" ? "WARNING" : "INFO", `budget notification: ${outcome}`, {
    costAmount: notification.costAmount,
    budgetAmount: notification.budgetAmount,
    alertThresholdExceeded: notification.alertThresholdExceeded ?? null,
  });
});
