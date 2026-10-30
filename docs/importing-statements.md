# Importing bank statements

Juntia's finances come from the bank's own PDF statements. Only the technical administrator imports
them, in **Finances > Import** (`/admin`); residents see the result in **Overview** and
**Transactions**, never the original PDFs.

## Contents

- [Supported format](#supported-format)
- [Importing a statement](#importing-a-statement)
- [The first import and the account](#the-first-import-and-the-account)
- [Duplicates and transaction identity](#duplicates-and-transaction-identity)
- [Previews and confirmation](#previews-and-confirmation)
- [Managing statements](#managing-statements)
- [Rules](#rules)
- [AI classification](#ai-classification)
- [Ordering, totals and balances](#ordering-totals-and-balances)
- [Accuracy and coverage](#accuracy-and-coverage)
- [Adding a bank format](#adding-a-bank-format)

## Supported format

Juntia reads one statement layout today: a text-based PDF whose transaction table has the column
headers **Data**, **Valor**, **Concepte**, **Import** and **Saldo**, with amounts in **EUR** and the
account's Spanish IBAN in the page header.

- A file can cover one month or several; its real date range is kept.
- The parser is deterministic and local: it reads the text of the PDF, handles independently
  positioned columns and checks every available running-balance transition with decimal
  arithmetic. No AI is involved in reading a statement.
- Both the booking date and the value date are kept; reports use the booking date. Dates are
  day/month/year; two-digit years are read as 2000 to 2099.
- Unknown layouts, scanned documents (there is no OCR), encrypted documents, inconsistent columns,
  invalid dates or amounts, balances that do not reconcile and ambiguous account headers are
  rejected with an explicit error. Text that is missing from the PDF cannot be recovered.
- Limits: 20 MiB, 50 pages and 10,000 transactions per file, a bound on the characters per page,
  and 45 seconds of parsing in an isolated child process.

## Importing a statement

1. **Select PDF** uploads the original. Nothing is saved yet: the server reads the document, checks
   the IBAN and reconciles the balances. Uploads are refused when they would leave less free space
   than `MIN_FREE_DISK_MB` on the uploads volume (`507 storage_low_space`).
2. The **Review import** dialog lists every transaction with its date and original description,
   amount and balance, and its status:
   - **New**: not recorded yet;
   - **Already recorded**: an exact duplicate of a stored transaction, which keeps its existing
     classification;
   - **Ambiguous match**: it might be a stored transaction. Choose **It is a different transaction:
     keep it as new** or **Link to existing transaction**; nothing is discarded automatically.
3. Matching [rules](#rules) and, when configured, [AI suggestions](#ai-classification) fill in the
   category, merchant and tags. You can edit any classification.
4. **Confirm and save the import** stores everything atomically. Closing the dialog before that asks
   for confirmation and saves nothing.

## The first import and the account

Juntia manages a single bank account per installation.

- On the first import, the IBAN is detected in the statement header and its checksum validated. The
  administrator must tick **I confirm that this IBAN belongs to the community account** and choose
  **Confirm detected account** before anything else happens, including AI requests.
- The account is only stored when that first import is confirmed successfully. Its default name is
  "Community account" (or its Spanish equivalent with `APP_LANGUAGE=es`); change it in the
  **Linked account** card of the Import page without affecting any transaction.
- Every later statement must belong to the same IBAN. It is checked when the PDF is read and again
  when the import is confirmed, and there is no way to bypass a mismatch.
- The registered IBAN cannot be changed, and removing every statement does not reset it. A different
  bank account needs a separate installation.
- A valid checksum proves consistency, not ownership: import only statements from a trusted source.

## Duplicates and transaction identity

The bank provides no transaction identifier in this layout, so Juntia builds one from the banking
evidence: the account, both dates, the original description, the signed amount, the currency and the
balance after the transaction. File names, periods, page and row positions, categories, tags and
merchant edits are not part of it. A separate checksum of the whole file recognizes the exact same
upload again, including ambiguities that were already resolved.

- Overlapping statements are deduplicated: the transactions already recorded are reported as such.
- Legitimate repeated payments with different evidence (for example a different balance after)
  remain separate transactions.
- Complete-key collisions or conflicting evidence are never merged or dropped silently: they require
  an explicit decision in the review.
- Original parsed fields and identities cannot be changed through the application, by the
  administrator or by the AI.

## Previews and confirmation

- A preview belongs to the administrator session that created it and expires after 24 hours
  (`PREVIEW_HOURS`). Expired previews and their files are removed at startup and before the next
  upload.
- If another import or a statement removal changes the ledger meanwhile, the preview becomes stale:
  load the PDF again when asked.
- Confirmation is atomic and safe to retry. Importing again never overwrites a manual
  classification.

## Managing statements

**Finances > Manage statements** lists the imported files with their period, new and duplicate
counts, opening and closing balances.

- **Download original PDF** returns the exact uploaded file. Statement originals and their metadata
  are available only to the administrator, also through the API.
- **Delete import** first shows how many transactions it would remove and how many are kept because
  another retained statement also supports them. Deleting a statement removes its original PDF.

## Rules

**Finances > Rules** classifies transactions automatically, on import and on demand:

- The first enabled rule that matches wins, ordered by priority (lowest first) and then by
  identifier.
- A rule matches the description (contains, starts with, exact match or a bounded regular
  expression, case-insensitive) and, optionally, the type (income or expense), limits on the
  absolute amount and the account's IBAN.
- It can set the category and the merchant, and add tags. Rules take precedence over AI
  suggestions, and **Skip AI when it matches** avoids sending those transactions to the provider.
- "Additional detail" conditions exist, but this statement layout has no separate detail field, so
  they evaluate against an empty detail rather than invented text.
- **Preview on history** shows how many stored transactions a rule matches; applying it to them
  changes their classification, including earlier manual corrections, and asks for confirmation.

Categories and tags are managed in **Finances > Categories and tags**; a category or tag can only be
deleted while it is not in use. Manual corrections are made in **Finances > Classify transactions**.

## AI classification

When `OPENAI_API_KEY` and `OPENAI_MODEL` are set (see [configuration](configuration.md#ai-classification)),
the import dialog asks an OpenAI-compatible provider for categories, merchants and tags:

- Suggestions start automatically once the account is validated (after the explicit confirmation on
  the first import) and cover every eligible transaction, in batches of up to 30, with visible
  progress. Editing and saving are blocked while a batch runs.
- The server chooses the transactions from its own preview and sanitizes their descriptions; the
  browser cannot substitute statement text. The model receives only those descriptions and the
  existing category and tag names, never the PDF, the account header, the amounts or the balances.
- The model can only pick existing categories and tags (create any new ones before importing) and
  propose merchants. It cannot change financial facts or run any tool.
- Transactions already recorded, batches already completed, manual corrections and rules marked to
  skip AI are not sent. Rules override AI suggestions, and manual corrections override both.
- Nothing is saved until the administrator reviews and confirms the import.
- Failures keep the preview and the batches that succeeded. The dialog offers to retry the pending
  suggestions or to continue with rules and manual editing; it never ignores a failure silently. A
  two-minute lease stops two requests from processing the same batch, and retrying after a timeout
  may be charged again by the provider.

**Sanitizing is not anonymizing.** Names or other personal details can remain in transaction
descriptions or in your own category names. Choose a provider and a data-processing policy you
trust, prefer a private endpoint where appropriate, or leave AI off: imports, rules and manual
classification work the same without it. The upload screen explains what is sent to the provider.

## Ordering, totals and balances

- Transactions on the same day follow the order of the retained statement rows, not the order in
  which they were inserted. Juntia keeps a derived order index that every import and statement
  removal rebuilds atomically. Filtered lists keep that order; sorting by amount or description
  uses it to break ties, and "oldest first" reverses it.
- Pages of 50 transactions, overview totals, monthly series, category shares and the top merchants
  are computed in the database with exact integer cents.
- The balance card shows the **observed** bank balance with its date, not a sum of transactions.
  When the latest day's transactions cannot be ordered and imply different balances, the balance is
  shown as unknown instead of guessed.
- A missing order entry produces an explicit error, never an apparently empty ledger or a made-up
  balance.

## Accuracy and coverage

- **Data available up to** shows the latest booking date in the ledger, not the upload date.
- Opening balances are not income. A partially covered month is not proof of a complete month, and
  an empty filtered result does not mean the history is complete.
- Failed requests never display synthetic data or replace totals with zeros.

## Adding a bank format

Support for more banks is the most useful contribution Juntia can receive. The parser lives in
`src/juntia/parser.py` and returns a `Statement` (`src/juntia/contracts.py`): the account IBAN and,
for each transaction, the booking and value dates, the description, the signed amount, the balance
after it and its position in the document. Everything after that (identity, deduplication,
ordering, rules and AI) is shared.

A new format should keep the same guarantees: reject what it cannot read with certainty, reconcile
the running balances, respect the limits above, and come with tests that build **synthetic** PDFs
(see `statement_pdf` in `tests/support.py`). The reader's version (`PARSER_VERSION` in
`src/juntia/identity.py`) is part of every transaction key, so changing it needs a migration that
re-keys the stored transactions, like `0020`. Please
[open an issue](https://github.com/DrDonoso/juntia/issues/new/choose) first to agree on the
approach, and never attach a real statement: describe the layout or share a synthetic sample. See
[CONTRIBUTING.md](../CONTRIBUTING.md).
