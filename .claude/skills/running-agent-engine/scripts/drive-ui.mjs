// Drives the agent-engine UI in headless Edge: sign-in errors, create agent, chat, live
// activity, reload, dark mode, phone width, viewer permissions. Writes PNGs to OUT_DIR.
// Usage (from a dir where `npm i playwright-core` was run):
//   node drive-ui.mjs [UI_URL=http://localhost:8080] [OUT_DIR=.]
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const URL = process.argv[2] ?? "http://localhost:8080";
const OUT = process.argv[3] ?? ".";
mkdirSync(OUT, { recursive: true });
const name = `smoke-${Date.now().toString(36)}`; // unique, so reruns don't collide
const errors = [];

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
const shot = (n) => page.screenshot({ path: join(OUT, `${n}.png`) });
const signIn = async (key) => {
  await page.getByLabel("API key").fill(key);
  await page.getByRole("button", { name: "Sign in" }).click();
};

await page.goto(URL);
await signIn("wrong-key");
await page.getByText("That key isn't recognized.").waitFor();
await shot("1-login-error");

await signIn("dev-admin-key");
await page.getByRole("button", { name: "+ New agent" }).click();
await page.getByLabel("Name").fill(name);
await page.getByLabel("System prompt").fill("You help with arithmetic. Be brief.");
await page.getByLabel(/add/).check();
await page.getByLabel(/get_current_time/).check();
await shot("2-create");
await page.getByRole("button", { name: "Create agent" }).click();

await page.getByText("Live", { exact: true }).waitFor();
await page.getByPlaceholder(`Message ${name}`, { exact: false }).fill("What time is it? Also add 2 and 3.");
await page.keyboard.press("Enter");
await page.getByText(/Run completed after \d+ turns?/).waitFor({ timeout: 120_000 });
await shot("3-chat");

await page.reload(); // session and history survive a reload
await page.getByRole("button", { name: new RegExp(name) }).click();
await page.locator(".bubble.assistant").first().waitFor();
await page.emulateMedia({ colorScheme: "dark" });
await shot("4-dark");
await page.setViewportSize({ width: 390, height: 844 });
await shot("5-mobile");
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

page.once("dialog", (d) => d.accept());
await page.getByRole("button", { name: "Delete" }).click();
await page.getByText("Pick an agent").waitFor();

await page.setViewportSize({ width: 1280, height: 800 });
await page.emulateMedia({ colorScheme: "light" });
await page.getByRole("button", { name: "Sign out" }).click();
await signIn("dev-viewer-key");
await page.getByRole("button", { name: "+ New agent" }).click();
await page.getByLabel("Name").fill("nope");
await page.getByRole("button", { name: "Create agent" }).click();
await page.getByText("Your key isn't allowed to create agents.").waitFor();
await shot("6-viewer");

await browser.close();
// Expected console errors: one 401 (wrong key) and one 403 (viewer create). Anything else is a bug.
console.log(JSON.stringify({ ok: true, screenshots: OUT, horizontalOverflowOnMobile: overflow, consoleErrors: errors }, null, 2));
