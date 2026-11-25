# Set up phi-router

You are a coding agent, and the human asked you to install phi-router. Name your harness. In Claude Code, follow [Claude Code](#claude-code). In Codex or pi, follow [Codex and pi](#codex-and-pi). In any other harness, reply that phi-router works only in Claude Code, Codex and pi, and end your turn.

## Claude Code

Setup runs in this window. A key must never enter this chat, because the chat goes to the human's subscription. So the human pastes keys in the plugin's masked field, which you cannot see. Say only the lines below, word for word, and nothing else.

1. Say "Checking what you have. Keys never show up here." Then run `npx phi-router setup claude --json`.
2. It prints one JSON step. Act on its `kind`:
   - `ask`: ask `question.text` with AskUserQuestion, one option per label in `question.choices`. Then run the command again with `--answers '<json>'`, where the JSON maps each question's `id` to the `id` of the choice picked so far, such as `--answers '{"baa":"key"}'`. Repeat step 2.
   - `stop`: say its `line` and end your turn.
   - `ready`: run `npx phi-router setup claude --apply --answers '<json>'` with the same JSON, and a 10-minute timeout, because a sign-in waits for the browser.
3. Say the last line the apply step printed. When it asks the human to paste keys or to sign in, end your turn, and when they say done, run step 2's `--apply` command again.

If `npx` is not found, type `bunx` instead. If the human pastes a key in this chat, do not repeat it, use it, or write it anywhere. Tell them the key went to their subscription's vendor with this chat, so they must revoke it where they got it and paste a new one in `/plugin configure phi-router`. If they ask for something else, such as a second subscription, a key in a password manager, or another model, point them to its section in [Accounts](https://github.com/drsh4dow/phi-router/blob/main/docs/accounts.md).

## Codex and pi

Setup asks for an API key, and a key must never enter this chat, because the chat goes to the human's subscription. So the human runs setup in their own terminal, and your whole job is one reply. Run no command and ask no question.

### Reply with the command

1. Send the message below word for word. Replace each `{blank}` with your harness's value from the table under it.

   > phi-router needs one thing from you: an API key from your {vendor} account that is covered by a BAA. Your {subscription} subscription stays as it is and keeps handling everything without patient data.
   >
   > A key must never go in this chat, so you paste it in a terminal. Open a new terminal window, not this one, and run:
   >
   > ```sh
   > npx phi-router setup {command}
   > ```
   >
   > If you use Bun instead of Node, type `bunx` instead of `npx`. {ending}

   | Harness | vendor    | subscription | command | ending                                                                     |
   | ------- | --------- | ------------ | ------- | -------------------------------------------------------------------------- |
   | Codex   | OpenAI    | ChatGPT      | `codex` | When setup finishes, close this Codex window and use the one setup starts. |
   | pi      | Anthropic | Claude       | `pi`    | When setup finishes, close this pi window and use the one setup starts.    |

2. End your turn.

### When the human writes back

- **They paste a key or a token.** Do not repeat it, use it, or write it anywhere. Tell them the key went to their subscription's vendor with this chat, so they must revoke it where they got it and get a new one. Then give them the command from step 1 again, with `--new-key` after it when setup already saved the old key.
- **They paste a line from setup.** Each failure line says what changed and what to run next. Say it back in plain words, and give them that command to run in their terminal. When the line says setup needs their own terminal, they ran it inside a coding agent: ask them to open a separate terminal window.
- **They ask for something else**, such as a second subscription, a Claude Enterprise login, a key in a password manager or an environment variable, a new key, or another model. Point them to its section in [Accounts](https://github.com/drsh4dow/phi-router/blob/main/docs/accounts.md). A step there that takes a key or a login is theirs to run in their own terminal.
