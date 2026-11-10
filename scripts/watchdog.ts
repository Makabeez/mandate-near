/**
 * Keeps the public demo alive: when the vault fires the agent, wait a little
 * (so the FIRED state stays visible on the dashboard), then rehire a fresh one
 * through the owner's normal `agent:add --rotate`.
 *
 *   npm run watchdog            # run under PM2, NOT exposed to the internet
 *
 * Runs as its own process: the public red-team server never holds the owner key.
 * Env: WATCHDOG_DELAY_SECS (default 120), WATCHDOG_MAX_PER_DAY (default 12).
 */
import { execFileSync } from "node:child_process";
import { mandate, optEnv, path } from "./config.ts";

const DELAY = Number(optEnv("WATCHDOG_DELAY_SECS") ?? "120") * 1000;
const MAX_PER_DAY = Number(optEnv("WATCHDOG_MAX_PER_DAY") ?? "12");
const m = mandate();
let firedSeenAt: number | null = null;
let day = new Date().toISOString().slice(0, 10);
let rehires = 0;

const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
log(`watchdog on ${m.vaultId}: rehire ${DELAY / 1000}s after a firing, max ${MAX_PER_DAY}/day`);

async function tick() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) [day, rehires] = [today, 0];
  const agents = await m.agents();
  if (agents.some((a) => a.active)) {
    firedSeenAt = null;
    return;
  }
  firedSeenAt ??= Date.now();
  if (Date.now() - firedSeenAt < DELAY) return;
  if (rehires >= MAX_PER_DAY) {
    log(`no active agent, but ${rehires} rehires today already: waiting for tomorrow (or double-click "Mandate rehire agent")`);
    return;
  }
  log("no active agent: rehiring");
  execFileSync("npx", ["tsx", path("scripts", "add-agent.ts"), "--rotate"], { cwd: path(), stdio: "inherit" });
  rehires++;
  firedSeenAt = null;
}

for (;;) {
  try {
    await tick();
  } catch (e) {
    log(`tick failed: ${String((e as Error).message ?? e).slice(0, 200)}`);
  }
  await new Promise((r) => setTimeout(r, 30_000));
}
