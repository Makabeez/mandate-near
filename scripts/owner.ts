/**
 * Owner controls. Every call is signed by the owner's full-access key.
 *
 *   npm run owner -- allow <account...>
 *   npm run owner -- disallow <account...>
 *   npm run owner -- approve <pending_id>
 *   npm run owner -- reject <pending_id>
 *   npm run owner -- pause | unpause
 *   npm run owner -- set-attesters <0xaddr...>
 *   npm run owner -- attestation on|off
 *   npm run owner -- policy key=value ...      e.g. max_per_tx=0.3 cooldown_secs=10
 *   npm run owner -- withdraw <near>
 *   npm run owner -- lock --yes                delete the vault's own full-access key (irreversible)
 */
import { Account, KeyPairSigner } from "near-api-js";
import { near, txHash, type Policy } from "../sdk/mandate.ts";
import { loadKey, mandate, ownerAccount, provider, txUrl, path } from "./config.ts";
import { renameSync } from "node:fs";

const [cmd, ...args] = process.argv.slice(2);
const m = mandate();
const owner = m.owner(ownerAccount());
const done = (r: unknown) => console.log(`✔ ${cmd} ${txUrl(txHash(r as never))}`);

switch (cmd) {
  case "allow":
    done(await owner.allow(args));
    break;
  case "disallow":
    done(await owner.disallow(args));
    break;
  case "approve":
    done(await owner.approve(Number(args[0])));
    break;
  case "reject":
    done(await owner.reject(Number(args[0])));
    break;
  case "pause":
    done(await owner.pause());
    break;
  case "unpause":
    done(await owner.unpause());
    break;
  case "set-attesters":
    done(await owner.setAttesters(args.map((a) => a.toLowerCase())));
    break;
  case "attestation": {
    const p = await m.policy();
    if ((await m.attesters()).length === 0 && args[0] === "on") throw new Error("register attesters first: npm run attestation");
    done(await owner.setPolicy({ ...p, require_attestation: args[0] === "on" }));
    break;
  }
  case "policy": {
    const p = (await m.policy()) as unknown as Record<string, unknown>;
    for (const kv of args) {
      const [k, v] = kv.split("=");
      if (!(k in p)) throw new Error(`unknown policy field ${k}`);
      p[k] = typeof p[k] === "number" ? Number(v) : typeof p[k] === "boolean" ? v === "true" : near(v);
    }
    done(await owner.setPolicy(p as unknown as Policy));
    break;
  }
  case "withdraw":
    done(await owner.withdraw(near(args[0])));
    break;
  case "lock": {
    if (!args.includes("--yes")) {
      console.log("This deletes the vault account's own full-access key. After it, nobody (you included) can redeploy");
      console.log("the contract or move funds except through the contract's rules. Re-run with --yes to do it.");
      process.exit(1);
    }
    const vk = loadKey("vault");
    const vault = new Account(vk.account_id, provider, KeyPairSigner.fromSecretKey(vk.private_key));
    done(await vault.deleteKey(vk.public_key));
    renameSync(path(".keys", "vault.json"), path(".keys", "vault.locked.json"));
    console.log("vault is locked: only the contract can now act for it.");
    break;
  }
  default:
    console.log("usage: npm run owner -- <allow|disallow|approve|reject|pause|unpause|set-attesters|attestation|policy|withdraw|lock> ...");
    process.exit(1);
}
