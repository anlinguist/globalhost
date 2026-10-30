// P1-00 smoke test, uploaded into the session (never added to numu-know). It checks numu-know#10:
// the page's CSP must allow audio from Firebase Storage. A blocked media load fires a
// securitypolicyviolation event before any network request, so this works without egress.
/* global document */
import { expect, test } from "@playwright/test";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const AUDIO = "https://firebasestorage.googleapis.com/v0/b/numu-know.appspot.com/o/smoke.wav?alt=media";

test("home page loads and its CSP allows Firebase Storage audio", async ({ page }) => {
  const response = await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  expect(response?.status()).toBeLessThan(400);

  const violations = await page.evaluate(async (src) => {
    const seen = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      seen.push(`${e.effectiveDirective} ${e.blockedURI}`);
    });
    const audio = document.createElement("audio");
    audio.src = src;
    document.body.appendChild(audio);
    audio.load();
    await new Promise((r) => setTimeout(r, 2000));
    return seen.filter((v) => v.includes("firebasestorage.googleapis.com"));
  }, AUDIO);

  await page.screenshot({ path: "/mnt/session/outputs/home.png", fullPage: true });
  expect(violations).toEqual([]);
});
