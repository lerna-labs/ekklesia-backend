# Contributing

Thanks for your interest in improving Ekklesia's voting backend.

## Filing issues

This repo doesn't take issues directly — file them in the
[docs repository](https://github.com/lerna-labs/ekklesia-docs), which tracks
work across the whole Ekklesia system. Bug reports and feature requests
opened here will be redirected there.

Security vulnerabilities are the one exception: see [SECURITY.md](SECURITY.md)
instead of filing a public issue anywhere.

## Making a change

1. Branch from `development` — that's the integration branch for this repo.
2. Make your change.
3. Run the local check:
   ```bash
   npm test
   ```
4. Add a changelog entry for your change (see below).
5. Open a pull request into `development`.

## Changelog entries

Every change needs a changelog entry. Run:

```bash
npx changeset
```

and follow the prompts — it writes a small markdown file under `.changeset/`
that you commit alongside your change. A pull request into `development`
without one (and without a skip-changelog label) will fail CI.

## Getting set up

See the [README](README.md) for install and local dev instructions,
including the `GITHUB_TOKEN` needed to install the private `@lerna-labs/*`
packages.
