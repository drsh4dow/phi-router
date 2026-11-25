# The router's life: start, lease, exit

## Sub-features

- `phi-router start` posts a lease, and launches `serve` when nothing answers on the port.
- `serve` exits within one lease interval (5 s) once no leased pid is alive, and after about 5 s when it never gets a lease.
- `status` takes a session and asks the running router.

## How to get to it (user POV)

Every harness's session start runs `phi-router start`; the user never starts the router by hand.

## Driving it with the real binary

- `bun run wire pi` checks the lease of each pi and the exit after the last one.
- [recipes.md](../recipes.md) holds the hand drives of `serve`, its exit paths and the empty-/tmp doctor.

## Gotchas

- `serve` needs `$XDG_CONFIG_HOME/phi-router/config.json` with a `clean` lane, or it fails with `SchemaError: Missing key at ["clean"]`.
- Kill only pids your run started; another session's router may be on the machine.
