# @qoren/cli

Drive your Qoren account, environments and agents from a terminal.

```bash
npm install -g @qoren/cli
qoren login
qoren            # the whole account on one screen
qoren env ls     # or one answer at a time
```

This is the short version. The full user guide, covering the sign-in flow, every
command, scripting, configuration and troubleshooting, is at
<https://qoren.sh/docs/cli>.

## Interactive mode

Run `qoren` with nothing after it at a terminal and it opens full screen:
environments, agents, jobs, a chat pane and your account, all on the keyboard.
`qoren tui` is the explicit form. Everything the commands can do it can do,
through the same credential and the same plan limits.

```
tab / 1-5     move between sections     enter   open what is selected
up down j k   move within a list        r       refresh
?             every key, in context     q       quit
```

Two things it does that a command cannot. A reply streams in as the agent
writes it, naming the tool it is running, instead of a spinner and then a wall
of text. And when a region cannot run the size you asked for, it offers you the
region that can, rather than printing a flag to re-run with.

Piping or a non-interactive shell is unaffected: `qoren` with no terminal still
prints the help text, and `--json` is refused rather than half-honoured.

## Commands

```
qoren login [--token] [--name <label>]   sign this computer in
qoren logout [--all]
qoren whoami

qoren env ls | get <id> | vitals <id>
qoren env create --name <n> [--size <s>] [--region <r>] [--auto-region]
qoren env rm <id> | rename <id> <name> | resize <id> --size <s>
qoren env collaboration <id> on|off

qoren agent ls [--env <id>] | get <id>
qoren agent create --env <id> --template <slug> --name <n> [--model <m>] [--runtime <r>]
qoren agent rm <id> | rename <id> <name>
qoren agent message <id> "<text>" [--resume <sessionId>]
qoren agent exec <id> "<command>"
qoren agent logs <id> [--limit <n>] | status <id> | telemetry <id> [--days <n>]
qoren agent doctor <id> [--no-repair] [--no-wait] | doctor <id> --history
qoren agent chatgpt-login <id> [--no-wait] | chatgpt-logout <id>

qoren account usage | spending [--days <n>] | options | templates

qoren jobs ls | get <id> | watch <id> | cancel <id>

qoren api <METHOD> <path> [--data <json|@file>] [--query k=v]

qoren tui                                open interactive mode
```

Run `qoren <command> --help` for full options.

## Regions

Leave `--region` off and the platform picks one that can run the size you
asked for. Pass `--region` and it is pinned: a region you named is never
swapped for another, so if it cannot run that size the create is refused
rather than quietly moved. The refusal names the closest region that does have
it, and `--auto-region` on a re-run is your permission to use it. It also lists
the sizes your region does have, in case staying put suits you better.

`qoren env resize` is refused the same way when the region an environment
already lives in cannot run the target size. There is no `--auto-region` there:
an environment cannot change region, so the refusal lists the sizes that region
can run and one of those is the way forward.

## Scripting

Every command takes `--json`. In that mode stdout carries only the payload;
progress and warnings go to stderr, so piping is safe.

```bash
qoren env ls --json | jq -r '.[].name'
```

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | the request failed |
| 2 | a mistake in the command |
| 3 | sign in again (missing, expired or revoked credential) |
| 4 | the plan does not allow this, including a plan without API access |

The CLI is API access, which the Ultimate, Business and Enterprise plans
include. On another plan every command exits 4 and names the plans that include
it; see <https://qoren.sh/pricing>. The web console works on every plan.

## CI

Create a token under Settings, CLI tokens, and set it as `QOREN_TOKEN`. It
overrides any stored login, so a pipeline can never pick up a developer's
profile.

```bash
export QOREN_TOKEN=qrn_...
qoren agent create --env "$ENV_ID" --template deploy-bot --name "Deploy bot" --json
```

## Configuration

| Variable | Effect |
| --- | --- |
| `QOREN_TOKEN` | token to use; the config file is not consulted |
| `QOREN_API_URL` | server to talk to (default `https://qoren.sh`) |
| `QOREN_PROFILE` | which stored login to use |
| `NO_COLOR` | disable colour |

Credentials live in `~/.config/qoren/config.json` (or `$XDG_CONFIG_HOME/qoren`),
written `0600`. It holds bearer tokens: treat it as a password. Named profiles
let you hold several logins; switch with `--profile`.

## Jobs

Creating an environment or deploying an agent is asynchronous. The CLI follows
the job and prints each step as it happens. Add `--no-wait` to get the job id
immediately and follow it later with `qoren jobs watch <id>`.

## Anything not yet a command

`qoren api` reaches any control-plane endpoint with the same credential and the
same rules, so a missing command is an inconvenience rather than a blocker.

```bash
qoren api GET fleetSummary
qoren api POST machines --data @environment.json
```

## Development

```bash
npm install
npm run check   # eslint + tsc
npm test
npm run build && node dist/index.js --help
```

Interactive mode is Ink (React on a terminal). Its logic lives in
`src/tui/model.ts` as pure functions so it can be tested without a screen;
`src/tui/model.test.ts` is where its behaviour is pinned down. Ink and React are
loaded dynamically, so a scripted `qoren env ls --json` never pays for them.

Commands live in `src/commands/` and call `@qoren/sdk`; interactive mode lives
in `src/tui/` and calls the same SDK. Neither ever builds a URL itself. That is the rule that keeps the CLI and the SDK in step: an endpoint
is described once, in the SDK, and every client reads it there.
