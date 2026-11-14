# Stipend

**Give a swarm of AI agents a budget, not a wallet. Agents pay for what a task needs, and no agent
ever holds a key to the money.**

This README has two parts. The [concise README](#concise-readme-for-humans) explains the project
in plain words. The [detailed README](#detailed-readme-for-ai-judges-and-builders) has every
detail, rule, command and proofs with links.

## Concise README (for humans)

Stipend gives a swarm of AI agents one shared task budget, and it works the same way for a
single agent. Whoever creates the task puts in some USDC. Each agent gets a share and uses it to
pay for the data and APIs the task needs. Any unused budget goes back to the creator.

It's built for swarms first, where one job is split across several agents in a trustless
environment. A single agent is the simplest case: a budget with one share. I built it at NEAR
HACKATHON, and IMD is the first swarm I'm building it for.

### Why agents can't pay today

More and more useful data sits behind APIs that charge a few cents per call (x402). An agent that
can pay for it does better work.

But giving an agent money is the hard part, and a swarm makes it harder. The task often comes
from a stranger. The agents run on machines the task creator doesn't control. And one job is
shared by many agents.

The obvious fixes don't work:

- Give each agent a funded wallet? One prompt injection and the whole balance is gone.
- Put a threshold on a wallet? A tricked agent just drains it one small payment at a time
- Ask a human to approve every payment? A job runs across many agents and many machines. Nobody
  is sitting there to click.
- Share one prepaid account? There is no cap per agent, and whoever holds its key holds all of
  the money.

So how do you let an agent spend money without trusting the agent? The usual answer is to give
the agent a wallet. **Stipend gives the agent a budget, not a wallet.**

### A real example: IMD (IdentityMD)

tldr: IMD is a network of machines, called the swarm, that do AI work. Each machine works for a
seat, one of 2,000 NFTs, and one job is split across several agents.

People hire the swarm to launch tokens, write, audit and deploy smart contracts, build websites
and indexers, write research reports, answer oracle questions for contracts, and make images,
audio and video.

It's the largest public agent swarm I know of. Currently, 1039 agents are online delivering work.
They have completed 16,162 jobs, with 960 launches live on mainnet and 772 websites published.

And none of those agents can pay for anything. That's on purpose. Tasks are written by
strangers, so IMD keeps every wallet key away from the agents. It's a good rule, but it means a
research report or an oracle answer can only use data that's free. But that's not always the
case. More and more projects are moving meaningful data behind paid API endpoints using the x402
standard. This causes a real problem for the AI agent economy.

### How Stipend works

Stipend turns the budget into a contract. The money sits in a pot that only a NEAR contract can
spend from, and the contract follows the budget's rules. The agent never gets a key to the pot,
and neither does the machine it runs on.

Here's a task from start to end:

1. The task creator opens a budget: a total, a cap per agent, a max per payment, the APIs that
   may be paid, and an end time.
2. They fund it with USDC on the chain where the APIs get paid. That's Base in this example, and
   it can be any EVM chain. The money goes into the budget's own pot.
3. The swarm's orchestrator gives each agent it assigns to the task a pass that expires. The
   pass can only ask the contract to pay. It can't move money.
4. An agent hits a paid API and asks the contract to pay. The contract checks the rules, and only
   if all of them pass does NEAR sign the payment. The API gets paid and the agent gets its data.
5. Anything outside the rules is refused, and nothing is signed.
6. When the task ends, the creator takes back whatever is left.

### Where NEAR comes in

The pot lives on the chain where the payment happens, but a NEAR contract owns it, through
NEAR's Chain Signatures. The rule check and the signature happen in one step, so there's no key
lying around for an agent to leak. To that chain the pot is a normal address, so paid APIs work
with it as they are. Nobody needs a gas token either.

That also makes Stipend multichain. One NEAR contract can hold budgets on many chains at the
same time: Base today, and any other EVM chain whose token supports signed transfers, like
USDC does. Nothing gets deployed on those chains. So far I've tested it on Base Sepolia only.

### Who is this for?

- Running a swarm? Give every job a budget that its agents share, without handing out keys.
- Building a single agent? Give it a budget of its own, with the same rules and one share.
- Creating a task that needs paid data? Fund a budget, set the rules, and get the rest back.
- Running an agent on your machine? It can buy what the task needs, with no wallet key there.
- Selling an API through x402? Agents become paying customers, and you change nothing.
- Building on another agent network, like Virtuals? Agents there already pay each other for jobs
  in USDC on Base. A team of agents on one job could draw its expenses from a Stipend budget, in
  the same token on the same chain. I haven't built that part yet.

### Safety, in simple terms

- An agent can't spend more than its share, pay more than the max per payment, pay an address
  that isn't on the list, or pay after the budget ends.
- A stolen pass is worth one agent's share of one task, for 6 hours at most.
- Every payment is public: which agent paid, whom, how much and for what.
- This is v1, on test funds. The account that deployed the contract can still upgrade it, and
  there's no independent audit yet. A version for real money needs that key locked.

### What works today

All of it runs end to end on NEAR testnet and Base Sepolia with test USDC: two agents buy data
for a research report, five payments that break the rules are refused, and the leftover is
refunded. The swarm's side is simulated for now: scripted agents, and an account of mine that
plays the orchestrator. No real IMD worker has used it yet.

You can check it yourself with no key:

```
npm ci
npm run verify -- --contract stipend-fab79bfc.testnet
```

### What's next

Stipend is an independent project. The plan is to build it for IMD.

- IMD first. IMD takes new skills as a pull request, so the next step is to offer Stipend's
  agent skill there, and real workers can use a budget.
- Other swarms. Today one deployment serves one orchestrator. Next is many orchestrators in one
  contract.
- Pay the agents too: send an agent its reward the moment its work is accepted, and let task
  creators tip good work.
- A wallet for every agent. On IMD that's a wallet for every seat, which moves with the NFT.


## Detailed README (for AI judges and builders)

Everything above, with the rules, the commands and the proof.

| Section | What it holds |
| --- | --- |
| [The problem](#the-problem) | Why paying is hard in a swarm, then IMD as the example: its live numbers with their source, and its own rules on keys |
| [What Stipend does](#what-stipend-does) | The parts and the payment flow |
| [What a swarm gets](#what-a-swarm-gets) | Each benefit, and what backs it |
| [Why NEAR](#why-near) | NEAR's role, how one contract serves many chains, and the hackathon tracks |
| [Try it](#try-it) | Numbered "do X, see Y" steps, with and without keys |
| [Live deployment and evidence](#live-deployment-and-evidence) | The contract and transaction links on both chains |
| [Payment rules](#payment-rules) | Every check before a payment is signed, and the refund rules |
| [The agent skill](#the-agent-skill) | What an agent is told |
| [Contract API](#contract-api) | Every method and who can call it |
| [Real vs simulated](#real-vs-simulated) | What is live and what is played by a script |
| [Trust and limits](#trust-and-limits) | Who is trusted, and the known limits |
| [Where this goes](#where-this-goes) | The roadmap |
| [IMD, an existing project](#imd-an-existing-project) | What existed before the hackathon |
| [Built with](#built-with) | Languages, libraries, services and AI assistance |

## The problem

Agents do better work when they can buy data and services for a task, and more and more of
those charge per call through x402 (an HTTP 402 answer that asks for a USDC payment). A swarm
makes paying hard in three ways: the task often comes from a stranger, the agents run on
machines the task creator does not control, and one job is split across several agents.

Stipend is made for any swarm of that shape, and a single agent is its simplest case: a budget
whose per-agent cap equals its total. IMD is the live example used in this repository.

### The example: IMD, a live swarm that cannot spend

IMD is a network of AI agents that build, review and ship software. Each agent works for an agent
seat (an NFT on Ethereum) on its holder's own machine, and one job is split across several agents.
IMD's public API showed this on 2026-11-14 at 19:36 UTC:

| Fact | Value | Source |
| --- | --- | --- |
| Agent seats | 2,000 | ERC-721 `0x0000ec93127baa929e58e97dd0095a2bfb38ec1d` on Ethereum |
| Seats enrolled with a worker | 1,084 | `/swarm`, `health.seatsEnrolled` |
| Agents online | 1,039 | `/swarm`, `health.agentsOnline` |
| Jobs completed | 16,162 of 16,717 | `/swarm`, `counts.jobStates.completed` and `counts.jobs` |
| Launches live | 960 | `/swarm`, `counts.launchesLive` |
| Sites published | 772 | `/swarm`, `counts.sites` |
| Work accepted in the last day | 995 | `/swarm`, `health.acceptedLastDay` |
| Oracle answers done in the last day | 18 | `/swarm`, `health.oraclesDoneLastDay` |
| Worker devices connected | 860 | `/workers`, `count` |
| Connected workers with the `research-report` skill | 653 | `/workers`, `workers[].skills` |

Read them again with `curl -s https://api.imd.fun/swarm` and `curl -s https://api.imd.fun/workers`.

What the swarm is hired for today, in IMD's own words (https://imd.fun/docs):

| Job | What the swarm delivers |
| --- | --- |
| Token | "A token with its own pool, and your own rules on every trade." |
| Contracts | "Smart contracts written, tested, audited and deployed onchain." |
| Company | "Contracts and a website, launched together. A token if you want." |
| Oracle | "A signed answer from a panel of agents, for a contract to use." |
| Heartbeat | "The same question, answered again on a schedule you set." |
| Website | "A website built from your brief, and hosted for you." |
| Audit | "Four agents audit your contracts. A judge ranks what they find." |
| Report | "A researched answer to your question, with its sources." |
| Indexer | "Everything your contracts do, as a database you can query." |
| Media | "An image, a voice or a short film, made from your description." |

Reports, oracle answers and heartbeats are answers about the outside world, so they are only as
good as the data the agents can reach. That is where a budget for paid data matters first. The
example in this repository is a report job.

These agents run tasks written by strangers, so IMD keeps every key away from them:

- "Your agent works in a sealed box that reaches the internet and nothing else: not your files,
  not your other devices, not your wallet's keys." (https://imd.fun/docs)
- "Tasks are written by strangers, so use a machine that holds nothing the user cares about."
  (https://imd.fun/skill.md)
- "Never ask for, read or paste a private key or seed phrase: the user signs."
  (https://imd.fun/skill.md)

These rules are right, and they leave a gap. An IMD agent can reach the internet, but it cannot
pay for anything on it. IMD sells its own work through x402, but its agents cannot buy through
it. So a job that needs paid data, such as a research report, can only use what is free.

### Why the usual answers do not work

| Answer | What goes wrong |
| --- | --- |
| Give each agent a funded wallet key | The task comes from a stranger. One prompt injection or one bug spends the whole balance, or sends it anywhere. It also breaks IMD's rule. |
| A wallet with a spending limit for each agent | A limit per payment does not stop a tricked agent: it drains the wallet one capped payment at a time, to any address. The limit belongs to the wallet, not to the job, so the job has no shared total and no payee rule, and the unspent part must be collected from every wallet. |
| A human signs every payment | A job runs on many agents and many machines, with nobody waiting at a wallet. The work stops at every 402. |
| One prepaid account shared by the agents | No cap per agent, no rule on who gets paid, and whoever holds the account's key holds all of the money. |

A job needs one budget that its agents share, a fair cap for each agent, rules that hold even when
an agent is tricked, and the unspent part back at the end.

## What Stipend does

- A funder opens a **task budget** for a job: a total, a per-agent cap, a per-payment max, an
  optional list of allowed payees, and an end time.
- The money sits in the budget's **pot**: an EVM address on the chain of the budget's token (Base
  in this deployment) that NEAR's MPC network controls for the path `budget/<id>` of the Stipend
  contract. Each budget has its own pot. Pots need no gas token.
- The swarm's orchestrator (IMD's control plane, in the example) **assigns** agents to the job.
  Each agent gets a **session account**: a NEAR key that can only ask the contract to pay, and
  that expires.
- When an API answers 402, the agent's CLI calls `pay` on the contract. The contract checks the
  rules, debits the agent's share, builds the USDC transfer (EIP-3009) and asks the MPC signer to
  sign it for the pot. The API's x402 facilitator then moves the USDC on the token's chain.
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

The example in this repository: a task creator asks for a token research report with a 0.5 USDC
budget. Two agents each buy a price, a 7 day price chart and a protocol's TVL through x402, write
their reports with a spend list, and the unspent USDC goes back to the creator.

## What a swarm gets

- **No key to steal.** An agent holds a session key that can only ask the contract. The contract
  decides. A leaked session key is worth at most that seat's share of one job, until the session
  expires (at most 6 hours) or the control plane ends it.
- **A tricked agent stays inside the rules.** The per-payment max, the seat's share, the payee
  list and the end time are checked on NEAR, not by the agent. With a payee list, "pay this other
  address" is refused and nothing is signed. The scenario checks five refused payments on testnet.
- **One budget, many agents.** A seat's first payment reserves its share. No agent can spend
  another agent's share, and a budget never takes more agents than it can pay for.
- **One agent works too.** A budget whose per-agent cap equals its total is a budget for a
  single agent, with the same rules.
- **Works with x402 as it is.** To the token's chain, a pot is an ordinary address that signs a
  standard USDC authorization. Paid APIs and facilitators need no change, and nothing is
  deployed on that chain. Payments here settled through two independent facilitators (x402.org
  and PayAI).
- **Many chains, one contract.** A budget names its token, and a token names its chain. One
  Stipend contract holds budgets on different EVM chains at the same time, each in its own pot.
- **Nobody needs a gas token.** Funding, payments and the refund are signed USDC authorizations
  that a facilitator settles. The funder, the pot and the agents hold no ETH on the token's
  chain.
- **The funder gets the rest back.** After the budget ends, one signed refund empties the pot.
- **Every payment has a public record.** The contract logs the seat, the payee, the value and the
  paid URL of each payment. Each one has a NEAR transaction that signed it and a Base transaction
  that settled it, and `npm run verify` checks the two against each other with no key.
- **The swarm stays as it is.** Nothing in the contract is specific to one swarm: a job id and a
  seat id are strings, and the orchestrator is a NEAR account. With IMD, the seat NFT stays in
  its holder's wallet on Ethereum, and IMD's protocol does not change. Shares and payments are
  recorded under the seat's token id.

## Why NEAR

- **A contract that owns addresses on other chains.** With Chain Signatures, the MPC network signs
  for a pot only when the Stipend contract asks, and the contract asks only from `pay` and
  `refund`, after the rules pass. No private key for a pot exists in one place: the MPC nodes
  hold only shares of it. So there is nothing to hand to an agent and nothing for it to leak.
- **One contract, many chains.** A token is registered with its chain id, its address and its
  EIP-712 name and version, and each budget names one token. So the same contract holds budgets
  in any EIP-3009 token on any EVM chain, side by side. The SDK and the agent's CLI read the
  chain from the budget's token and have no chain of their own. A new chain needs one
  `register_asset` call and an x402 facilitator that serves it, and nothing deployed there. This
  deployment registers USDC on Base Sepolia, the only chain tested so far.
- **Throwaway agent identities.** A session account is a NEAR implicit account: a new key pair is
  already an account id. The contract ties it to one job and one seat until it expires.
- **Refusals that can be read.** Every payment and every refusal is a NEAR transaction with a
  plain message, and the contract emits NEP-297 events for payments and refunds.

How it fits the hackathon tracks:

| Track | How Stipend fits |
| --- | --- |
| Agent Economy (`agents`) | Agents pay for APIs and data per call, in USDC through x402, signed with Chain Signatures |
| AI Swarms (`swarms`) | The agents of one job buy from one shared budget, with a share per agent and a public spend log |
| NFTs That Do Something (`nfts`) | An agent seat NFT gets spending rights: shares and payments are recorded under its token id, and the NFT never leaves its holder's wallet |

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

Part of the output, for the budget of one scenario run:

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
| A refund signed on NEAR, for a run settled by the PayAI facilitator | [`EyxfZ74D...`](https://testnet.nearblocks.io/txns/EyxfZ74DWoGeFDiD1EtQu5tEGzt4AbgiLJTGJn6MjBbi) |
| The same refund settled on Base by PayAI | [`0xfe1ce9a5...`](https://sepolia.basescan.org/tx/0xfe1ce9a5deb3911c2e707d3df787b919a47a23e6c3c3dc6de4074b09a95a67e0) |
| The pot of that run | [`0x4f7E4B8f...`](https://sepolia.basescan.org/address/0x4f7E4B8f3BD1d6a0fea2e7fB9EB667ec5E1f4b31) |

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
| USDC transfers on Base Sepolia, settled by the x402 facilitators at https://x402.org/facilitator and https://facilitator.payai.network | The paid API: our own test server on localhost, using the real x402 middleware |
| Token and protocol data from DefiLlama | The funds: test USDC and testnet NEAR |
| IMD's numbers in [The problem](#the-problem), read from IMD's public API | The job and seat ids: test values, not real IMD jobs or seats |

## Trust and limits

Who is trusted:

- **The oracle account** (the swarm's orchestrator) decides which session works for which seat
  on which job. A wrong assignment can spend a seat's share, but only within the budget's caps
  and payee list.
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
- **One chain tested.** The contract, the SDK and the CLI take the chain from the registered
  token, but only USDC on Base Sepolia has been run. The demo scripts are written for Base.
- **EVM chains and EIP-3009 tokens only.** The contract builds one kind of transfer: an EIP-3009
  authorization on an EVM chain.
- **One orchestrator per deployment.** The contract has one oracle account, so each swarm needs
  its own deployment.
- **Session accounts need NEAR for gas.** In the demo the control plane sends each one 0.2
  testnet NEAR.

More detail: [docs/threat-model.md](docs/threat-model.md).

## Where this goes

Stipend starts with task budgets. The goal is a wallet for every agent in a swarm. None of the
steps below is built yet.

1. **Run inside IMD.** Stipend is not part of IMD yet. IMD takes new skills as an issue or a pull
   request (https://github.com/Identity-md/identitymd-skill-crafting), so the first step is to
   offer the agent skill there, in IMD's skill format. A worker also needs a session. An oracle
   that reads the assignments from IMD's public job data, with a grant signed by the worker's
   device key, can give it one. The mapping and the needed changes are in
   [docs/imd-integration.md](docs/imd-integration.md).
2. **Mainnet.** `demo-mainnet/` holds the deploy, budget, funding, session, refund and verify
   scripts for NEAR mainnet and USDC on Base. There is no mainnet deployment yet. A production
   deployment needs a locked or DAO-governed contract account.
3. **Pay the agents, not only the APIs.** Today a seat earns a share of the tokens the swarm
   launches, and it waits until the holder claims it (https://imd.fun/docs). The same pots can
   pay each seat the moment its work is accepted, and let a task creator tip good work. USDC
   payouts use the signed transfer the contract already builds. Payouts in IMD need a transfer
   type that the IMD token supports (IMD's own x402 payments use Permit2).
4. **A wallet per seat.** From a budget per job to a standing wallet bound to the seat NFT: it
   holds what the seat earns, follows the holder's own spending rules, and moves with the NFT
   when the seat is sold.
5. **Other swarms.** Many orchestrators in one contract, in place of one oracle account per
   deployment. Nothing in the contract is specific to IMD, so it can serve other agent networks.
   On Virtuals' Agent Commerce Protocol, for example, each agent has its own wallet and signer
   key, and agents pay each other for jobs in USDC, with Base in its examples
   (https://github.com/Virtual-Protocol/acp-node-v2). A team of agents that works on one such
   job could draw its expenses from a Stipend budget, in the same token on the same chain, with
   no shared signer key. This is not built or tested.
6. **No NEAR for agents.** A relayer with NEAR meta transactions (NEP-366) pays the gas, so a
   session account needs no funding.

## IMD, an existing project

IMD (https://imd.fun) is an existing project: a network of AI agents, with 2,000 agent seats (an
ERC-721 NFT on Ethereum) and a control plane that assigns jobs to agents. Stipend is an
independent project built on top of IMD. It is not part of IMD and does not change it. In this
repository IMD's job and control plane are simulated by an oracle account
(`demo-testnet/control-plane.ts`), and the agents are scripted. Everything in this repository was
built during the hackathon. How Stipend plugs into IMD:
[docs/imd-integration.md](docs/imd-integration.md).

## Built with

- Contract: Rust with `near-sdk` 5.30.1.
- Scripts, SDK and CLI: TypeScript run directly by Node 22.18 or newer, with `near-api-js`
  7.4.0, `viem` 2.57.13, `@x402/core`, `@x402/evm`, `@x402/express` and `@x402/fetch` 2.29.0,
  and `express` 5.3.0. Type checks use `typescript` 7.0.2.
- Services: NEAR testnet RPC (FastNEAR), the NEAR testnet faucet, NEAR Chain Signatures
  (`v1.signer-prod.testnet`), Base Sepolia, Circle's test USDC, the x402 facilitators at
  https://x402.org/facilitator and https://facilitator.payai.network, and the DefiLlama API.
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
| `demo-mainnet/` | The deploy, control plane, budget, funding, refund and verify scripts for NEAR mainnet and Base, run with `npm run mainnet:<name>` |
| `docs/` | Threat model and IMD integration |

## Notes for builders

- `npm run build:contract` compiles with `--cfg near`. near-sdk 5.30 needs this flag to use NEAR's
  host functions. Without it, the contract still runs, but every refusal shows up on-chain as a
  bare `unreachable` trap with no message.
- `.env` holds keys and is never committed. `.env.example` lists every setting. `npm run verify`
  needs only the public settings in `.env.example`.
- The mainnet scripts read `.env.mainnet`, which is never committed either. `.env.mainnet.example`
  lists its settings.
- Session keys from the control plane go to `.env.session.<seat_id>` files, or into `--dir`. They
  are never committed either.

## License

MIT, see [LICENSE](LICENSE).
