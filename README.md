# Stipend

Task budgets for AI agents, enforced by a NEAR contract. A funder puts USDC into a budget for one
job. Every agent assigned to the job can spend up to a fixed share of it on paid APIs (x402 on
Base). No agent holds a key that can move the money: the contract checks each payment against the
budget's rules on NEAR, and only then NEAR's MPC network (Chain Signatures) signs it.

Built for NEAR HACKATHON. It builds on IMD, an existing agent network (see
[IMD, an existing project](#imd-an-existing-project)).

## The problem

IMD runs a network of AI agents. Each agent works for an agent seat (an NFT on Ethereum), and one
job is split across several agents. Many tasks need paid data or services, and more and more APIs
charge per call through x402 (an HTTP 402 answer that asks for a USDC payment). An agent cannot pay
for them safely today:

- IMD's own agent skill says an agent must never handle a private key, and that the user signs
  every payment. So an agent cannot buy anything on its own.
- A funded wallet key gives an agent the whole balance. A bug or a prompt injection can spend all
  of it, or send it anywhere.
- A job has several agents. Their spending has to come out of one task budget, with a fair cap for
  each agent.

## What Stipend does

- A funder opens a **task budget** for a job: a total, a per-agent cap, a per-payment max, an
  optional list of allowed payees, and an end time.
- The money sits in the budget's **pot**: an EVM address on Base that NEAR's MPC network controls
  for the path `budget/<id>` of the Stipend contract. Each budget has its own pot. Pots need no ETH.
- IMD's control plane **assigns** agents to the job. Each agent gets a **session account**: a NEAR
  key that can only ask the contract to pay, and that expires.
- When an API answers 402, the agent's CLI calls `pay` on the contract. The contract checks the
  rules, debits the agent's share, builds the USDC transfer (EIP-3009) and asks the MPC signer to
  sign it for the pot. The API's x402 facilitator then moves the USDC on Base.
- After the budget ends and a grace period passes, the funder **refunds** what is left in the pot.

```
 Funder                         NEAR testnet                         Base Sepolia
 create_task_budget  ------->   Stipend contract
 signed USDC transfer  ------------------------------------------->  pot of the budget

 Control plane (oracle account)
 assign(job, seat, session)  ->  Stipend contract

 Agent (stipend CLI)
 GET paid URL  ---------------------------------------------------->  paid API answers 402
 pay(budget, transfer)  ----->  Stipend contract checks the rules,
                                MPC signer signs for the pot
 <---------------------------  EVM signature
 GET with the payment  ------------------------------------------->  facilitator moves USDC
                                                                     from the pot to the API
```

## Payment rules

`pay` signs nothing unless all of these hold, checked in this order:

1. The caller has a session, and the session has not expired.
2. The budget exists, is not closed and has not expired.
3. The session is for the budget's job.
4. The seat has a share. A seat's first payment reserves the per-agent cap, if the budget still
   has room for it. Otherwise the payment is refused with "Budget is full".
5. The value is above zero, at most the per-payment max, and at most what is left of the seat's
   share.
6. The payee is on the budget's list, when the budget has one.
7. The authorization is valid now and expires within 900 seconds.
8. The nonce is not the budget's refund nonce.
9. The resource URL is at most 512 bytes.

Every payment is logged with its seat, payee, value, nonce, resource URL and status. The contract
cannot see Base, so a payment counts as spent once it is signed. If signing fails, the contract
gives the value back to the seat's share.

Refund rules:

- Only the budget's funder can ask for a refund.
- A refund is allowed from 900 seconds after the budget ends (closed or expired). By then every
  payment authorization has expired.
- The signed refund is valid on Base only from that same time, so it cannot settle while a
  payment still can, even if Base's clock is behind NEAR's.
- The refund nonce is fixed per budget (`keccak256("stipend:refund", budget_id)`). USDC accepts a
  nonce once, so at most one refund of a budget settles. The refund script refunds the pot's whole
  balance.

## Try it

### Without any key

Needs Node 22.18 or newer and Rust (tested with 1.96).

1. Clone the repository, then run `npm ci`.
2. Run `npm run typecheck`. You see no errors.
3. Run `npm run test:contract`. You see `test result: ok. 101 passed`. The unit tests cover every
   payment and refund rule, the EIP-712 hash against vectors from viem, and the MPC reply against
   a real testnet reply.
4. Run `npm run verify -- --contract stipend-fab79bfc.testnet`. It reads the live contract on NEAR
   testnet and USDC on Base Sepolia. For each budget you see its limits, its pot balance, each
   seat's share, each payment marked settled or not settled on Base, whether the refund settled,
   and four consistency checks. It ends with `All checks passed`.

Part of the output, for the budget of the last scenario run:

```
Budget 2: job scenario-1794644843, closed 2026-11-14T08:30:50.000Z
  funder stipend-fab79bfc.testnet, payees 0x9081F51AD866C6d4c6F7Ad758Dea7FC43a7649e6
  limits: 0.5 USDC total, 0.25 USDC per agent, 0.01 USDC per payment
  pot 0x1D2393d85e8900dBE0bd28e7dDb0ac8CADa47D30 holds 0 USDC: https://sepolia.basescan.org/address/0x1D2393d85e8900dBE0bd28e7dDb0ac8CADa47D30
  refund settled: yes
  seat 1: spent 0.03 USDC of 0.25 USDC
  seat 2: spent 0.03 USDC of 0.25 USDC
  #0 seat 1 0.01 USDC Signed, not settled, http://localhost:4021/prices/coingecko:near
  #1 seat 1 0.01 USDC Signed, settled, http://localhost:4021/chart/coingecko:near
  ...
  OK: spent total equals the payments in the log
  OK: spent total equals the seats' spent shares
  OK: reserved total equals the seats' shares
  OK: only signed payments settled on Base
```

Payment #0 shows the known limit described in [Trust and limits](#trust-and-limits): the API did
not settle it, so its 0.01 USDC stayed in the pot and went back to the funder with the refund.

### Full run on the testnets

Uses free test funds only. Also needs the wasm target: `rustup target add wasm32-unknown-unknown`.

1. Run `npm run setup:testnet`. It creates two NEAR testnet accounts with the testnet faucet (the
   contract account and the oracle account), two EVM keys (the funder and the paid API), and
   writes `.env`. It prints the funder address.
2. Get test USDC on Base Sepolia for the funder address at https://faucet.circle.com. One USDC is
   enough for a run.
3. Run `npm run deploy`. It builds the contract, then deploys it, initializes it and registers
   USDC on Base Sepolia in one transaction. It prints the config and the asset.
4. Run `npm run scenario`. It runs the whole example in one command (steps below) and ends with:
   ```
   == Result
      Refusals as expected: 5 of 5
      Balance checks passed: 3 of 3
      Reports: reports/scenario-<time>-seat-*.md
      The funder can ask for a refund of budget <id> from <time>
   ```
5. Open `reports/scenario-<time>-seat-1.md`. You see the agent's research report. It ends with a
   spend table: each paid URL, the amount, and links to the NEAR transaction that signed it and
   the Base transaction that settled it.
6. After the time printed in step 4, run `npm run refund -- <id>`. You see
   `Refunded on Base: <link>` and `Pot balance: 0 USDC`.
7. Run `npm run verify`. The budget shows `refund settled: yes`.

What `npm run scenario` does:

1. The funder opens a 0.5 USDC budget for a new job: 0.25 USDC per agent, 0.01 USDC per payment,
   and the paid API as the only allowed payee. In the demo the contract account is the funder.
2. 0.5 test USDC moves from the funder wallet to the pot. The funder signs a USDC authorization
   and the x402 facilitator settles it, so the funder needs no ETH.
3. The control plane assigns seats 1 and 2 to the job. It funds each session account with 0.2
   testnet NEAR for gas and storage.
4. Two scripted agents follow `skill/SKILL.md`. Each one checks `status`, buys a coin's price, its
   prices over 7 days and a protocol's TVL through the CLI, and writes a report.
5. Five payments that break the rules. Each must be refused with the expected message, and the
   budget's payment log must not change, so nothing was signed:

   | Attempt | Refused by |
   | --- | --- |
   | An API that charges 0.05 USDC, through the CLI | The CLI's spend limit, before NEAR |
   | The same 0.05 USDC payment sent straight to `pay`, skipping the CLI | Contract: "Value is above the per-payment max" |
   | An API that pays an address not on the budget's list | Contract: "Payee is not on the budget's list" |
   | The oracle account, which has no session, calls `pay` | Contract: "Caller has no session" |
   | A purchase after the funder closes the budget | Contract: "Budget is closed or expired" |

6. Balance checks: the contract's spent total equals its payment log, the pot holds what was
   funded minus what settled on Base, and the paid API received exactly what settled.

The scenario starts the paid API itself when nothing answers on its port.

### Each part by hand

| Command | What it does |
| --- | --- |
| `npm run paid-api` | Paid data API on http://localhost:4021: DefiLlama data behind x402 on Base Sepolia. Routes `/prices/:coins`, `/chart/:coins` and `/tvl/:protocol` cost 0.01 USDC. `/overpriced/prices/:coins` costs 0.05 USDC, and `/unlisted-payee/prices/:coins` pays an address no budget lists. |
| `npm run create-budget -- <job_id> <total> <per_agent_cap> <per_payment_max> [--hours <hours>]` | Opens a budget and prints its id and pot address |
| `npm run fund-pot -- budget/<id> <amount>` | Moves test USDC from the funder wallet to a pot |
| `npm run control-plane -- <job_id> <seat_id>... [--hours <hours>] [--dir <dir>]` | Creates, funds and assigns a session account per seat, and saves each key to `.env.session.<seat_id>` |
| `npm run stipend -- status --session <file>` | Shows the seat, the job, and what the seat can spend from each budget |
| `npm run stipend -- fetch <url> --budget <id> --session <file>` | Fetches a URL and pays from the budget if it answers 402 |
| `npm run agent -- --session <file> --budget <id> --coin <coin> --protocol <slug> --out <file>` | Scripted research agent that writes a report with its spend list |
| `npm run refund -- <budget_id> [--to <address>]` | Refunds what is left in a pot to the funder wallet, or to `--to` |
| `npm run verify -- [--contract <account id>]` | Prints the evidence for every budget, with no key |

## Live deployment and evidence

All on NEAR testnet and Base Sepolia.

| What | Where |
| --- | --- |
| Stipend contract | [`stipend-fab79bfc.testnet`](https://testnet.nearblocks.io/address/stipend-fab79bfc.testnet) |
| MPC signer | `v1.signer-prod.testnet` (NEAR Chain Signatures) |
| Token | USDC on Base Sepolia, `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| A payment signed on NEAR | [`Hn1LkNFT...`](https://testnet.nearblocks.io/txns/Hn1LkNFTHGBoQ7EHh2W3aQbtfQAauUg5x2h2abms8QuY) |
| The same payment settled on Base | [`0x5cca75cb...`](https://sepolia.basescan.org/tx/0x5cca75cbcbe82a81b452b4f1caf471b0bd60cf431b6dd32f3ebbaa8f009289f6) |
| A refund signed on NEAR | [`9EiQEe7T...`](https://testnet.nearblocks.io/txns/9EiQEe7TMnRNLTd3asNyfDJDD8orBMvDwpDT6rryYnT3) |
| The same refund settled on Base | [`0x4688be0d...`](https://sepolia.basescan.org/tx/0x4688be0d254c3e85c4acc734ca4e87d5f1a24840ccd3ede349d920d43542f09d) |
| A pot: funding in, payments out, refund out | [`0x1D2393d8...`](https://sepolia.basescan.org/address/0x1D2393d85e8900dBE0bd28e7dDb0ac8CADa47D30) |

## The agent skill

[`skill/SKILL.md`](skill/SKILL.md) tells an agent, such as an IMD worker, how to use the wallet:

- when to use it;
- the two CLI commands, `status` and `fetch`;
- its rules: check `status` first, stay inside its share, pay once per piece of data, do not retry
  a refused payment with other values, end the task output with a spend list, and never ask for a
  key;
- what each refusal message means.

## Contract API

| Caller | Method | What it does |
| --- | --- | --- |
| Contract account | `new(owner, oracle, mpc_signer_id)` | Initializes the contract |
| Owner | `register_asset(asset_id, asset)` | Registers a token: chain id, address, EIP-712 name and version, decimals |
| Owner | `set_oracle(oracle)` | Replaces the control plane account |
| Oracle | `assign(job_id, seat_id, session_account, expires_at)` | Assigns a session account to a seat on a job, for at most 6 hours |
| Oracle | `unassign(session_account)` | Ends a session |
| Anyone | `create_task_budget(job_id, asset_id, limits, payees, expires_at)` | Opens a budget. The caller becomes its funder and pays for its storage. |
| Funder | `close_budget(budget_id)` | Stops new payments |
| Session | `pay(budget_id, transfer, resource)` | Checks the payment rules and returns the EVM signature of the transfer. The caller pays for the payment's storage. |
| Funder | `refund(budget_id, from, to, amount)` | Returns the signed transfer of what is left, from 900 seconds after the budget ends |
| Contract | `on_payment_signed`, `on_refund_signed` | Private callbacks that read the MPC reply |
| Anyone | `get_config`, `get_asset`, `get_budget`, `get_budgets_for_job`, `get_session`, `get_share`, `get_payments` | Views |

Methods that change rules or move funds (`register_asset`, `set_oracle`, `assign`, `unassign`,
`close_budget`, `refund`) require exactly 1 yoctoNEAR, so only a full-access key can call them.
The contract emits NEP-297 events with the standard `stipend`: `payment` (with its status) and
`refund`.

## Real vs simulated

| Real | Simulated |
| --- | --- |
| The Stipend contract on NEAR testnet, with every rule check and refusal | IMD's job and its assignment: an oracle account we run plays IMD's control plane |
| MPC signatures from NEAR Chain Signatures | The agents: scripted Node programs that follow the skill, not IMD workers |
| USDC transfers on Base Sepolia, settled by the x402 facilitator at https://x402.org/facilitator | The paid API: our own test server on localhost, using the real x402 middleware |
| Token and protocol data from DefiLlama | The funds: test USDC and testnet NEAR |

## Trust and limits

Who is trusted:

- **The oracle account** (IMD's control plane) decides which session works for which seat on which
  job. A wrong assignment can spend a seat's share, but only within the budget's caps and payee
  list.
- **The contract owner** can upgrade the contract, and the contract controls every pot. A mainnet
  version needs a locked or DAO-governed contract.
- **The MPC network** holds the key shares behind every pot, as in any Chain Signatures app.
- **The x402 facilitator** can refuse to settle, but it cannot move more than a signed payment
  allows.
- **A paid API** can take a payment and not deliver. The loss is capped by the per-payment max.

Known limits:

- **Signed means spent.** The contract cannot see Base. If a signed payment never settles, it
  still counts against the seat's share, while its USDC stays in the pot and goes back to the
  funder with the refund. This happened once in the scenario run shown above.
- **One refund per budget.** The refund nonce is fixed, so USDC sent to a pot after its refund
  settled stays there.
- **The funder states the refund amount.** The contract cannot read the pot's balance. The refund
  script reads it from Base.
- **Session accounts need NEAR for gas.** In the demo the control plane sends each one 0.2
  testnet NEAR.

More detail: [docs/threat-model.md](docs/threat-model.md).

## IMD, an existing project

IMD (https://imd.fun) is an existing project by another team: a network of AI agents, with 2,000
agent seats (an ERC-721 NFT on Ethereum) and a control plane that assigns jobs to agents. Stipend
builds on IMD and does not change it. In this repository IMD's job and control plane are
simulated by an oracle account (`demo-testnet/control-plane.ts`), and the agents are scripted. Everything
in this repository was built during the hackathon. How Stipend plugs into IMD:
[docs/imd-integration.md](docs/imd-integration.md).

## Built with

- Contract: Rust with `near-sdk` 5.30.1.
- Scripts, SDK and CLI: TypeScript run directly by Node 22.18 or newer, with `near-api-js`
  7.4.0, `viem` 2.57.13, `@x402/core`, `@x402/evm`, `@x402/express` and `@x402/fetch` 2.29.0,
  and `express` 5.3.0. Type checks use `typescript` 7.0.2.
- Services: NEAR testnet RPC (FastNEAR), the NEAR testnet faucet, NEAR Chain Signatures
  (`v1.signer-prod.testnet`), Base Sepolia, Circle's test USDC, the x402 facilitator at
  https://x402.org/facilitator, and the DefiLlama API.
- Templates: none. The repository started empty, with only a license.
- Code written before the hackathon: none.
- AI assistance: written with Claude Code (Anthropic) as the coding assistant. The author reviewed
  and committed every change, one small step at a time.

## Repository layout

| Path | What it holds |
| --- | --- |
| `contract/` | The Stipend contract (Rust): assets, sessions, budgets, payments, refunds, the EIP-712 hash and the MPC call |
| `sdk/` | TypeScript library: pot address, budget reads, `pay` and `refund` calls, and an x402 signer backed by the contract |
| `cli/stipend.ts` | The agent's CLI: `status` and `fetch` |
| `skill/SKILL.md` | Instructions for an agent |
| `demo-testnet/` | Testnet setup, deploy, control plane, budget and funding scripts, paid API, research agent, scenario, refund and verify |
| `docs/` | Threat model and IMD integration |

## Notes for builders

- `npm run build:contract` compiles with `--cfg near`. near-sdk 5.30 needs this flag to use NEAR's
  host functions. Without it, the contract still runs, but every refusal shows up on-chain as a
  bare `unreachable` trap with no message.
- `.env` holds keys and is never committed. `.env.example` lists every setting. `npm run verify`
  needs only the public settings in `.env.example`.
- Session keys from the control plane go to `.env.session.<seat_id>` files, or into `--dir`. They
  are never committed either.

## License

MIT, see [LICENSE](LICENSE).
