UniiChat
========

[▶ Watch the announcement video](https://x.com/VictorTaelin/status/2108200878553588091)

**This repo is vibe-coded.** AI agents wrote nearly all of it, and AI
agents reviewed it. Read it, run it and fork it as such: expect bugs.

UniiChat is an AI agent with one chat that never ends. There is no "new
chat" button: you talk to the same agent for days, weeks, years, and it
remembers. The hosted version is at https://uniichat.com. This is its
source, to run your own server on your own API keys.

How it works
------------

- **One chat, a memory tree.** Every message is summarized into one line,
  and neighboring lines are merged in pairs, again and again, into a
  binary tree. Each call sees a view of the whole chat, up to 128 KB:
  recent messages one line each, older ones covered by fewer, broader
  lines. Detail fades with age, but nothing is lost.
- **Zoom.** The agent can open any line into the two it was made from,
  down to the original message. So its context never rots, and it never
  needs a "compaction" that throws the past away.
- **Built in the background.** Summaries are written by a cheaper model
  (the compactor) as messages arrive. The view changes only at its end,
  so each call reads most of its input from the vendor's prompt cache.
- **Every window is a view.** The server owns the chat. A browser tab, or
  `unii` in a terminal, shows it live; any of them can send a message,
  stop the work, or change the model.
- **Agents and tools.** The agent runs a shell, reads and edits files,
  and can drive a Mac's screen, on any computer where `unii` is open
  (each is a device it can name). It can spawn subagents, which work in
  the background and report back as messages.
- **Import.** Bring your past Claude and ChatGPT chats (Claude Code and
  Codex folders, or the websites' exports); they join the tree.

The design is in the header comment of each file. Start with Memory.ts
(the tree and the view), Server.ts (the chat, turns, workers) and
AskAI.ts (model calls and the cache).

Run it
------

You need [Bun](https://bun.sh) and an Anthropic API key (or an OpenAI
one, below).

    export ANTHROPIC_API_KEY=sk-ant-...
    bun Server.ts                    # http://127.0.0.1:8788, data in ~/.unii

Then open http://127.0.0.1:8788 and type your email. With no mail key
set, the server prints the sign-in link in its output: open it. Or chat
from a terminal:

    bun Term.ts http://127.0.0.1:8788

It asks for your email, the server prints a link, and the page it opens
asks for the code the terminal shows. `bun Term.ts help` lists the rest.

Other commands:

    bun run test                     # the tests, each file on its own
    bun run web                      # rebuilds web/app.js from web/src
    bun build --compile Term.ts --outfile unii
                                     # one `unii` executable; `unii serve`
                                     # runs the server it carries

Your chats live in ~/.unii/users/<id>, one JSON line per message
(main/) and per summary (tree/). They are the memory: back them up.

Config
------

`~/.unii/config.json` (optional; the dir is `$UNII_DIR`). Each key may
also be set as the variable `UNII_<KEY>`, which wins over the file. The
server's owner can also change most of them, and the keys, at the
bottom of the Settings page (☰ menu, or /settings); see below.

- `site`: the server's origin, for sign-in links (default
  http://127.0.0.1:8788). Another port: `UNII_SITE=http://127.0.0.1:9000
  bun Server.ts 9000`.
- `vendors`: what the server offers, comma-separated: `claude-api`
  (default), `openai-api`.
- `models`: the models offered, by label (Pick.ts; default all).
- `pick`: what a chat runs on until it picks another,
  `vendor:model:effort:speed` (default `claude-api:sonnet-5.5:medium:slow`).
- `compactor`: what writes the summaries (default
  `claude-api:haiku-5.5:high:slow`).
- `agents`: what subagents run on (default: the chat's pick).
- `work`: the agents' working dirs on each device (default
  ~/.unii/work).
- `rules`: a file appended to every system prompt.
- `after`: a shell command run after each turn.
- `workers`: how many processes serve the users (default none: one
  process). With a number, `Server.ts` only routes, behind a proxy that
  honors its `x-unii-worker` header (Server.ts explains).
- `apple`, `apns`: the iOS app's App ID and push key id (ios/).
- `owner`: who may open the Settings page: sign-in emails,
  comma-separated (e.g. `"owner": "you@example.com"`). Set here or as
  `UNII_OWNER` only, never on the page. None named: no one may.

Keys are read from the environment: `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `RESEND_API_KEY` (to email sign-in links; none: they
print), `APNS_KEY`. One the environment doesn't set is read from
`~/.unii/keys.json` (mode 600), where the Settings page puts them.

For the owner, the Settings page also shows the server's settings it
can change, and each key by its last 4 characters only; a save is
checked as a start checks config.json and applies at once on every
worker (vendors, models, pick, compactor, agents, keys) or on the next
start (`site`, `apple`, `apns`). `owner`, `workers`, `work`, `rules`,
`after` and what the environment sets are changed on the server only,
and not shown.

With only an OpenAI key, set `vendors`, `pick` and `compactor` to
`openai-api` models, e.g. `UNII_VENDORS=openai-api
UNII_PICK=openai-api:gpt-6.1-sol:medium:slow
UNII_COMPACTOR=openai-api:gpt-6-luna:high:slow`.

A self-hosted server is free: it bills no one, shows no prices, and calls
only the model vendors. Billing.ts is the one place a hosted server
plugs in its billing (uniichat.com sells credits; this repo has none).

The `unii` terminal
-------------------

`web/install.sh` (served at /install.sh) runs the official installer,
which installs the released `unii` executable. `unii` alone opens
uniichat.com; `unii <url>` opens any server. Run with
`UNII_COMPUTER=1` on a Mac, the agent may use its screen (it compiles
Computer.swift with swiftc; macOS asks for Screen Recording and
Accessibility).

Telemetry: once a day the `unii` terminal asks bend-lang.com's /check
for the latest version (Term.ts update_check), sending its version, OS
and CPU type, no account and no id; it also says whether this computer
has ever self-hosted (set for good the first time it runs `unii serve`
or opens a server other than uniichat.com). It is the one call a
self-hosted UniiChat makes to us. `UNII_NO_TELEMETRY=1` turns it off.

License
-------

Apache-2.0 (LICENSE). Copyright 2026 Higher Order Company.
