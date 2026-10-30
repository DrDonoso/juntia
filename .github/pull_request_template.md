<!--
Thanks for contributing! Please read CONTRIBUTING.md first:
https://github.com/DrDonoso/juntia/blob/main/CONTRIBUTING.md
Report security vulnerabilities privately (see SECURITY.md), never in a pull request.
-->

## Summary

<!-- What does this pull request change, and why? -->

## Related issue

<!-- For example: Closes #123. For larger changes, please open an issue first. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactoring without behavior changes
- [ ] Documentation
- [ ] Translations
- [ ] Tests, CI or tooling
- [ ] Dependency update

## Validation

<!-- The commands you ran and their results, plus any manual checks. -->

## Checklist

<!-- Check what applies and write "N/A" next to items that do not. -->

- [ ] Tests are added or updated.
- [ ] Backend checks pass: `pytest`, `ruff`, `mypy` and `scripts/export_openapi.py --check`.
- [ ] Frontend checks pass: `npm run gen:api -- --check`, `lint`, `test`, `build`, `e2e` and `e2e:demo`.
- [ ] API changes: `openapi.json` and `schema.gen.ts` are regenerated and committed.
- [ ] New or changed interface text is translated in both `locales/en` and `locales/es`.
- [ ] New or changed API operations have demo handlers, or are marked as unavailable in the demo.
- [ ] Documentation is updated (README, `docs/`, `.env.example`).
- [ ] Schema changes include a new Alembic migration with a downgrade, and tests.
- [ ] No secrets, real bank data or personal data in code, fixtures, logs or screenshots.
- [ ] Interface changes include screenshots with synthetic data.

## Screenshots

<!-- For interface changes: before and after, with synthetic data only. -->
