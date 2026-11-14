# Threat model

Stipend lets AI agents spend from a shared task budget. This page lists what protects the money,
who is trusted, and what is still open. Rule numbers refer to the payment rules in the
[README](../README.md#payment-rules).

## What is protected

The USDC in a budget's pot on Base. Only NEAR's MPC network can sign for a pot, and for the Stipend
pots it signs only when the Stipend contract asks. The contract asks from two methods only:

- `pay`, after every payment rule passes;
- `refund`, for the budget's funder, once the budget has ended and the grace period has passed.

The contract has no method that signs an arbitrary hash. It builds every EIP-712 hash itself, for
a registered token, from fields it has checked.

## Parties

| Party | Holds | Can do |
| --- | --- | --- |
| Funder | The NEAR account that created the budget, and the wallet that funded the pot | Close the budget early, ask for the refund |
| Control plane (oracle account) | The NEAR key named in the contract's config | Assign and unassign session accounts |
| Agent | A session account key (a NEAR implicit account) | Ask the contract to pay, within its seat's share |
| Contract owner | The owner account in the config | Register tokens and change the oracle |
| Contract account | Full access to the account the contract runs on | Upgrade the contract |
| MPC network | The key shares behind every pot | Sign what the contract asks |
| x402 facilitator | A gas wallet on Base | Settle signed transfers, or refuse to |
| Paid API | Its payee address | Deliver the data, or not |

In this deployment the contract account is also the owner and the funder of the demo budgets.

## Threats

| Threat | Outcome | Enforced by |
| --- | --- | --- |
| A prompt injection tells an agent to pay an attacker's API | Refused when the budget has a payee list. Without a list, the loss is capped by the per-payment max and the seat's share. | Rule 6 |
| An agent asks to pay more than the per-payment max | Refused, nothing signed | Rule 5. The CLI also caps payments at 0.01 USDC. |
| An agent tries to spend more than its share | Refused | Rule 5 |
| An agent skips the CLI and calls `pay` directly | The same rules apply. The contract is the boundary, and the CLI is only a convenience. | All rules |
| A third agent joins a budget that has room for two shares | Refused with "Budget is full" | Rule 4 |
| An account with no session calls `pay` | Refused | Rule 1 |
| An agent uses a session from another job | Refused | Rule 3 |
| A session key leaks | Limited to that seat's share on that job, until the session expires (at most 6 hours) or the control plane removes it | Rules 1 to 5 |
| A signed payment is submitted twice | USDC accepts each nonce once per pot | USDC on Base |
| A payment authorization stays valid for a long time | Refused when it is valid for more than 900 seconds | Rule 7 |
| An agent pays with the budget's refund nonce, so the refund can never settle | Refused | Rule 8 |
| Someone other than the funder asks for a refund | Refused | `refund` |
| A refund while payments can still settle | Refused on NEAR until 900 seconds after the budget ends. The signed refund is also not valid on Base before that time. | `refund`, and the refund's `valid_after` |
| The same refund is signed twice | Only one can settle, because the refund nonce is fixed per budget | USDC on Base |
| Someone asks the contract to sign any other hash | There is no such method | The contract |
| The MPC network fails to sign | The payment is marked failed and its value goes back to the seat's share | `on_payment_signed` |

## Trust assumptions

- **The oracle account** decides which session account works for which seat on which job. A
  wrong assignment lets that session spend the seat's share, within the caps and the payee list.
  IMD's public job data can replace this trust later (see [IMD integration](imd-integration.md)).
- **The contract account** can deploy new code, and the contract controls every pot. A mainnet
  version needs a locked or DAO-governed contract account.
- **The MPC network** holds the key shares, as for any Chain Signatures app.
- **The x402 facilitator** can refuse to settle or delay a settlement. It cannot move more than a
  signed transfer allows, or send it anywhere else.
- **A paid API** can take a payment and not deliver. The loss is capped by the per-payment max.

## Known limits

- **Signed means spent.** The contract cannot see Base, so a signed payment counts against the
  seat's share at once. If it never settles, the seat loses that part of its share, while the
  USDC stays in the pot and goes back to the funder with the refund.
- **One refund per budget.** USDC that reaches a pot after its refund settled stays there.
- **The funder states the refund amount.** The contract cannot read the pot's balance. The refund
  script reads it from Base and refunds all of it.
- **The resource URL is a claim.** The payment log stores the URL the agent says it paid for. The
  contract enforces payee addresses, not domains.
- **Session accounts need NEAR for gas.** A relayer with NEAR meta transactions (NEP-366) would
  remove this.
- **No global pause.** A funder can close a budget, and the control plane can end a session.

## How it is tested

- `npm run test:contract`: unit tests for each payment rule, share reservation, both callbacks,
  each refund rule, and the EIP-712 hash and refund nonce against vectors from viem.
- `npm run scenario`: five refusals on testnet, each checked by its message and by an unchanged
  payment log, then balance checks between NEAR and Base.
- `npm run verify`: with no key, checks every budget's totals against its payment log and its
  shares, and that only signed payments settled on Base.
