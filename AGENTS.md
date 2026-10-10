# AGENTS.md — sethucms-adapter-sdk

The adapter contract, the GuardedAdapter layer and the conformance test kit.

This repository is one part of SethuCMS. **Read `../sethucms/AGENTS.md` first** for the whole picture, the security rules that must not be broken, and the working agreements.

## Build and test

```sh
pnpm install && pnpm build && pnpm test
```

## Notes

Build `../sethucms` core first. Do not weaken GuardedAdapter or the conformance tests: every adapter must pass them.

## Always

- Run the tests for what you changed and say what you ran and what you could not run.
- Do not `git commit` or `git push` unless the owner asks.
- Never print or store a secret, token or password.
