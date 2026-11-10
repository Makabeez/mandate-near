/**
 * Write the live testnet links into README.md (between the live markers), from
 * deployments/<network>.json and evidence/<network>-run.jsonl.
 *
 *   npm run readme -- --dashboard https://mandate-near.vercel.app --post https://x.com/... --video https://youtu.be/...
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { accountUrl, loadDeployment, path, txUrl, NETWORK } from "./config.ts";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const d = loadDeployment();
const dashboard = arg("dashboard");
const post = arg("post");
const video = arg("video");

// Pick one proof transaction of each kind from the agent runs.
const runFile = path("evidence", `${NETWORK}-run.jsonl`);
const runs = existsSync(runFile)
  ? readFileSync(runFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { tx?: string; result?: { status: string; reason: string; agent_revoked: boolean }; attested_by?: string; invoice: { invoice_id: string } })
  : [];
const pick = (f: (r: (typeof runs)[number]) => boolean) => runs.find((r) => r.tx && f(r));
const proofs = [
  ["paid", pick((r) => r.result?.status === "paid" && !r.attested_by)],
  ["paid with a NEAR AI TEE signature checked on-chain", pick((r) => r.result?.status === "paid" && !!r.attested_by)],
  ["held for the owner", pick((r) => r.result?.status === "queued")],
  ["refused: not an approved vendor (prompt injection)", pick((r) => r.result?.reason === "receiver_not_allowlisted")],
  ["refused: over the per-payment cap", pick((r) => r.result?.reason === "over_per_payment_cap")],
  ["third strike: agent fired, key deleted in the same transaction", pick((r) => !!r.result?.agent_revoked)],
] as const;

const lines = [
  `| | |`,
  `|---|---|`,
  dashboard ? `| Dashboard | [${dashboard.replace(/^https?:\/\//, "")}](${dashboard}) |` : "",
  `| Vault contract | [\`${d.vault}\`](${accountUrl(d.vault)}) (${d.network}) |`,
  `| Owner | [\`${d.owner}\`](${accountUrl(d.owner)}) |`,
  `| Deploy + init (one tx) | [${d.txs.deploy_init.slice(0, 10)}…](${txUrl(d.txs.deploy_init)}) |`,
  `| Wasm sha256 | \`${d.wasm_sha256}\` |`,
  ...proofs.filter(([, r]) => r).map(([label, r]) => `| ${label[0].toUpperCase()}${label.slice(1)} | [${r!.invoice.invoice_id}](${txUrl(r!.tx!)}) |`),
  video ? `| Demo video | ${video} |` : "",
  post ? `| Demo post | ${post} |` : "",
].filter(Boolean);

let readme = readFileSync(path("README.md"), "utf8");
readme = readme.replace(/<!-- live-testnet:start -->[\s\S]*?<!-- live-testnet:end -->/, `<!-- live-testnet:start -->\n${lines.join("\n")}\n<!-- live-testnet:end -->`);
if (dashboard && !readme.includes("live_demo-try_to_trick_it")) {
  readme = readme.replace(
    /\[!\[Judge demo\]\(https:\/\/img\.shields\.io\/badge\/judge_demo-npm_run_judge-1F2559\?style=for-the-badge\)\]\(#try-it-in-one-command\)/,
    `[![Live demo](https://img.shields.io/badge/live_demo-try_to_trick_it-B0262F?style=for-the-badge)](${dashboard}) [![Judge demo](https://img.shields.io/badge/judge_demo-npm_run_judge-1F2559?style=for-the-badge)](#try-it-in-one-command)`,
  );
}
readme = readme.replace(/\(#live-on-testnet\)/, `(${accountUrl(d.vault)})`);
writeFileSync(path("README.md"), readme);
console.log(`README updated: ${lines.length - 2} rows, ${proofs.filter(([, r]) => r).length} proof transactions`);
const missing = proofs.filter(([, r]) => !r).map(([l]) => l);
if (missing.length) console.log(`no proof tx yet for: ${missing.join("; ")}`);
