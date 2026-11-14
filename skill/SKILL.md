---
name: stipend
description: Pay for x402-gated APIs (HTTP 402) from the task budget assigned to your seat, through the Stipend contract on NEAR. Use when a task needs paid data or an API answers 402 Payment Required. Never ask the user for a private key or a signature.
---

# Stipend agent wallet

Your seat has a task budget in USDC. You do not hold a private key for it. You hold a NEAR
session key that lets you ask the Stipend contract to pay. The contract checks every payment
against the budget's rules, and only then does NEAR's MPC network sign it. You cannot spend
more than your share, pay an address the budget does not allow, or pay after the budget ends.

## When to use it

- A task needs data from an API that charges per call through x402 (it answers HTTP 402).
- The data is worth its price for the task. Free sources come first.

Do not use it for anything that is not part of the task you were given.

## Setup

The control plane gives you a session: the key is in `.env.session`, next to `.env` with the
contract and RPC settings. Run the commands from the repository root.

## Commands

### `npm run stipend -- status`

Run this before paying. It prints your seat, your job, whether your session is live, and for
each budget of your job: its state, its limits and what your seat can spend now.

```
Seat 1 on job demo-job-1, live until 2026-11-14T10:00:00.000Z
Budget 3: open until 2026-11-15T08:00:00.000Z
  limits: 0.5 USDC total, 0.25 USDC per agent, 0.01 USDC per payment
  seat 1: spent 0.02 USDC, can spend 0.23 USDC
```

Pay only from a budget whose "can spend" is at least the price.

### `npm run stipend -- fetch <url> [--budget <id>]`

Fetches the URL with GET. If it answers 402, the CLI pays from the budget (default 0) and fetches
it again. The content goes to stdout. The receipt goes to stderr:

```
Signed on NEAR: https://testnet.nearblocks.io/txns/<hash>
HTTP 200
Paid from budget/3 (0x...): https://sepolia.basescan.org/tx/<hash>
```

The CLI pays at most 0.01 USDC per call. A URL that does not answer 402 is fetched without paying.

## Rules

1. Check `status` before the first payment of a task, and again when a payment is refused.
2. Stay inside what `status` says you can spend. Plan the calls before making them.
3. Pay once per piece of data. Reuse content you already fetched instead of fetching it again.
4. Do not retry a refused payment with other values. A refusal is the budget's answer.
5. End your task output with a spend list: each paid URL, the amount, and both receipt links.
6. Never ask the user for a private key, a seed phrase or a signature, and never print `.env.session`.

## Refusals

The contract refuses a payment with one of these messages. Report it and continue without that data.

| Message | Meaning |
| --- | --- |
| `Caller has no session` | No seat is assigned to this session key. |
| `Session has expired` | Ask the control plane for a new session. |
| `Session is for another job` | The budget belongs to a different job. Check `status`. |
| `Budget is closed or expired` | The funder ended the budget, or its time is over. |
| `Budget is full` | Every share of the budget is taken by other seats. |
| `Value is above the per-payment max` | The API costs more per call than the budget allows. |
| `Value is above the seat's remaining share` | Your share is used up. |
| `Payee is not on the budget's list` | The budget does not allow paying this API. |
