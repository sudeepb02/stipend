// Plays IMD's control plane with the oracle key: creates an agent's session account, funds it
// with NEAR for gas and storage, and assigns it to a seat on a job
import { existsSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";

const EXPLORER_TX_URL = "https://testnet.nearblocks.io/txns";
const SESSION_FILE = new URL("../.env.session", import.meta.url);
// 0.2 NEAR
const SESSION_FUNDING = 200_000_000_000_000_000_000_000n;
const ONE_YOCTO = 1n;
const CALL_GAS = 30_000_000_000_000n;
const USAGE = "Usage: npm run control-plane -- <job_id> <seat_id> [--hours <hours>]";

// Usage: npm run control-plane -- <job_id> <seat_id> [--hours <hours>]
async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { hours: { type: "string", default: "6" } },
  });
  const [jobId, seatId] = positionals;
  const hours = Number(values.hours);
  if (!jobId || !seatId || !(hours > 0)) {
    throw new Error(USAGE);
  }
  const { NEAR_RPC_URL, STIPEND_CONTRACT_ID, ORACLE_ID, ORACLE_KEY } = process.env;
  if (!NEAR_RPC_URL || !STIPEND_CONTRACT_ID || !ORACLE_ID || !ORACLE_KEY) {
    throw new Error("Set NEAR_RPC_URL, STIPEND_CONTRACT_ID, ORACLE_ID and ORACLE_KEY in .env");
  }
  if (existsSync(SESSION_FILE)) {
    throw new Error(".env.session exists. Remove it to create a new session.");
  }
  const provider = new JsonRpcProvider({ url: NEAR_RPC_URL });
  const oracle = new Account(ORACLE_ID, provider, ORACLE_KEY as KeyPairString);

  // A session account is an implicit account: its id is the hex of its ed25519 public key
  const sessionKey = KeyPair.fromRandom("ed25519");
  const sessionAccountId = Buffer.from(sessionKey.getPublicKey().data).toString("hex");
  // Saves the key before funding, so a funded account always has its key on disk
  writeFileSync(SESSION_FILE, `STIPEND_SESSION_KEY=${sessionKey.toString()}\n`, { mode: 0o600 });

  const funding = await oracle.transfer({ receiverId: sessionAccountId, amount: SESSION_FUNDING });
  console.log(`Session account ${sessionAccountId} funded with 0.2 NEAR`);
  console.log(`Transaction: ${EXPLORER_TX_URL}/${funding.transaction.hash}`);

  const expiresAt = Math.floor(Date.now() / 1000) + Math.round(hours * 3600);
  const assignment = await oracle.callFunctionRaw({
    contractId: STIPEND_CONTRACT_ID,
    methodName: "assign",
    args: {
      job_id: jobId,
      seat_id: seatId,
      session_account: sessionAccountId,
      expires_at: String(expiresAt),
    },
    deposit: ONE_YOCTO,
    gas: CALL_GAS,
    waitUntil: "FINAL",
  });
  console.log(`Assigned seat ${seatId} on job ${jobId}`);
  console.log(`Transaction: ${EXPLORER_TX_URL}/${assignment.transaction.hash}`);
  const session = await provider.callFunction({
    contractId: STIPEND_CONTRACT_ID,
    method: "get_session",
    args: { session_account: sessionAccountId },
  });
  console.log(`Session: ${JSON.stringify(session)}`);
  console.log("Session key saved to .env.session");
}

await main();
