# ibkr-flex-dividends

Download every **dividend**, the **withholding tax** taken from it, **payments in lieu** and
**bond interest** from your Interactive Brokers account, using IBKR's Flex Web Service. One file,
no dependencies (Node 18 or later).

```
node ibkr-flex.js fetch --from 2022-01-01     fetch your history into cash.json (cached)
node ibkr-flex.js summary                     per holding: gross, tax, net, effective tax rate
node ibkr-flex.js csv > income.csv            every row, for a spreadsheet or a tax return
```

```
symbol  ccy  payments   gross     tax  interest     net  tax rate
MC      EUR         4  110.00  -27.50      0.00   82.50     25.0%
MSFT    USD         8   26.40   -3.96      0.00   22.44     15.0%
```

(Illustrative figures.)

The **tax rate** column is the useful surprise: it shows what each market actually withheld. Above,
France took its full 25% statutory rate rather than its 12.8% treaty rate (the difference can be
reclaimed), which is easy to miss on a statement.

## Why this exists

The Flex Web Service is the official way to get your own statements as data, but it has edges the
documentation does not make obvious. This tool handles them:

- **One request covers at most 365 days**, so a long history is fetched a year at a time.
- **It serves completed days only.** A range ending today is refused, so the default end is
  yesterday.
- **Before an account existed, it answers error 1003, "Statement is not available".** That is
  treated as "no data for this period", not as a failure.
- **A token belongs to your login, not to one account.** If you have several accounts, or an old
  one that was migrated into a new one, one token serves them all, with a query each. A closed or
  migrated account usually still answers.
- **Rapid requests get throttled** (error 1018); the tool waits and retries.

Finished years are cached in `cash.json` and never fetched again; the last two windows are
refreshed on each run, in case of late postings or reversals.

## Setup

You need an IBKR account. Flex Queries and the Flex Web Service are part of IBKR's account
management, available to account holders at no extra cost.

1. **Create a Flex Query.** In Client Portal: Performance & Reports → Flex Queries → Activity Flex
   Query → create. Add the **Cash Transactions** section and tick at least *Dividends*,
   *Withholding Tax*, *Payment In Lieu Of Dividends* and *Bond Interest Received/Paid*. Choose
   **XML** format. The period you set does not matter: the tool asks for its own dates. Save it
   and note its **Query ID**.
2. **Turn on the Flex Web Service.** Client Portal → Settings → Flex Web Service → enable, and
   generate a **token**. You can set how long it stays valid and restrict it to your IP address.
3. **Write `ibkr-flex.json`** next to the script:

   ```json
   {
     "token": "your token",
     "accounts": [
       { "name": "main", "query": "123456" },
       { "name": "old-account", "query": "234567" }
     ]
   }
   ```

   One account is enough. For a single account you can instead set the environment variables
   `IBKR_FLEX_TOKEN` and `IBKR_FLEX_QUERY`. An account can carry its own `"token"` if it belongs to
   a different login.

4. **Fetch**, from the day your (oldest) account opened, or any earlier date:

   ```sh
   node ibkr-flex.js fetch --from 2022-01-01
   ```

   Later runs need no `--from`: it is remembered in `cash.json`. Options: `--to YYYY-MM-DD`,
   `--config file`, `--out file`.

## Output

`cash.json` holds every row, grouped by account and year. Each row is:

| field | |
|---|---|
| `date` | the payment date |
| `exDate` | the ex-dividend date, where IBKR gives one |
| `account`, `symbol`, `isin`, `description` | as IBKR reports them |
| `type` | Dividends, Withholding Tax, Payment In Lieu Of Dividends, Bond Interest Received, Bond Interest Paid |
| `currency`, `amount` | in the payment's own currency; tax and interest paid are negative |

IBKR's symbols are its own: a Hong Kong stock appears as `1` rather than `0001.HK`, and a company
can pay under a second symbol (LVMH's interim dividend arrived as `MOHd`). Match on `isin` when
joining this to other data. Amounts are never converted between currencies.

## Security

**The token can read your statements.** Keep `ibkr-flex.json` and `cash.json` out of version
control (the included `.gitignore` does), set the token to expire, and restrict it to your IP if
you can. It cannot place trades or move money.

## Licence

MIT. See [LICENSE](LICENSE). Not affiliated with Interactive Brokers.
