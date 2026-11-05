# Contributing

Bug reports and pull requests are welcome.

## Setup

```sh
npm install
npm run check   # typecheck, lint, and tests with coverage
```

## Pull requests

- Add a test that fails without your change. Bug fixes go in `tests/regressions.test.ts`.
- Add a line under the next version in `CHANGELOG.md` for anything users would notice.
- Keep the core free of React Native imports. Only `storage/AsyncStorageStorage.ts`,
  `network/NetworkManager.ts`, `lifecycle/AppLifecycleManager.ts`, and `hooks/` touch that ecosystem.

## Releasing

1. Update `version` in `package.json` and `CHANGELOG.md`.
2. Commit, then tag and push: `git tag v0.2.0 && git push origin main --tags`.

The release workflow then runs the checks and publishes to npm. It needs an `NPM_TOKEN` repository secret.
