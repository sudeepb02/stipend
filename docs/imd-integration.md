# How Stipend plugs into IMD

IMD (https://imd.fun) is an existing network of AI agents. Stipend is an independent project
built on top of it. It is not part of IMD and does not change IMD's protocol. This page shows
how the two fit together. In this repository the IMD side is simulated.

## IMD in short

- IMD has 2,000 agent seats: an ERC-721 NFT on Ethereum
  (`0x0000ec93127baa929e58e97dd0095a2bfb38ec1d`). A seat holder pairs a worker device with a seat.
- IMD's control plane (https://api.imd.fun) splits a job into steps and gives each step to a
  seat's worker. `GET /jobs/:id` shows which seat worked on each step.
- IMD's agent skill (https://imd.fun/skill.md) says an agent must never handle a private key, and
  that the user signs every payment.

## How the parts map

| IMD | Stipend |
| --- | --- |
| A job | A budget's `job_id`. `get_budgets_for_job` lists the job's budgets. |
| A seat (its token id) | The `seat_id` of a session and of a share |
| The control plane giving a step to a seat | `assign(job_id, seat_id, session_account, expires_at)`, called by the oracle account |
| A worker running the agent | Holds the session key and runs the `stipend` CLI as `skill/SKILL.md` says |
| The task creator | The budget's funder |

## The flow with IMD

1. A task creator opens a budget for the job and funds its pot. The funding can be a signed USDC
   authorization that the x402 facilitator settles, so the creator needs no ETH.
2. When IMD's control plane gives a step to a seat, it creates a session key (a NEAR implicit
   account), sends it a little NEAR for gas, calls `assign`, and hands the key to the worker with
   the step.
3. The agent follows `skill/SKILL.md`: `stipend status`, then `stipend fetch` for paid URLs. It
   never holds a key that can move USDC. Its session key can only ask the contract, and the
   contract decides.
4. When the step ends, the control plane calls `unassign`, or the session expires.
5. When the job ends, the creator closes the budget, or it expires. After the grace period the
   creator refunds what is left.

This keeps IMD's rule: the agent never handles a key that can pay on its own.

## What IMD would add

None of this is needed to run the demo.

- The agent skill in IMD's skill format. IMD takes new skills as an issue or a pull request on
  https://github.com/Identity-md/identitymd-skill-crafting.
- A worker hook that receives the session key with a job step, in place of the demo's key files.
- The control plane's own NEAR account as the oracle, set with `set_oracle`.
- Later, no oracle at all: assignments read from IMD's public job data (`GET /jobs/:id`, field
  `nodes[].seat.tokenId`), then grants signed by the worker's device key.
- A relayer with NEAR meta transactions (NEP-366), so session accounts need no NEAR.

## What this repository simulates

- `demo-testnet/control-plane.ts` plays IMD's control plane with the oracle key. It creates the session
  accounts, funds them and calls `assign`.
- `demo-testnet/agent.ts` plays the agent on an IMD worker. It runs the CLI the way the skill says.
- Job ids such as `demo-job-2` and seat ids such as `1` and `2` are made up. They are not real IMD
  jobs or seats.
