# Starlane demo runbook

A 7-minute demo of the real product, on a business that enters Starlane the same way a customer would.

## What you need

| | |
|---|---|
| Website | The production site (or the local fallback below) |
| Demo files | `Apex-Bills-Receivable.xlsx` and `EXPECTED.md`, made the same morning with `npm run demo:dataset` |
| Account | A fresh Apex account created that morning through the real sign-up form (see "Morning of the meeting") |
| Backup | The local fallback running on your laptop, with its own Apex account |

Apex Industrial Supplies Pvt Ltd is fictional. Its 29 bills and totals are in `EXPECTED.md`, worked out independently of Starlane, so you can check the screen against them.

## Morning of the meeting (15 minutes)

1. In the backend repo: `npm run demo:dataset`. The bill dates count back from today, so overdue days stay correct.
2. Run `npm run demo:readiness -- --api <backend URL> --site <website URL> --full`. Fix every FAIL line before the meeting.
3. Open the website in a clean browser profile and sign up a new company:
   - Name: your own name
   - Company: Apex Industrial Supplies Pvt Ltd
   - Email: an inbox you can open on your phone
4. Enter the 6-digit code from the email.
5. On onboarding, choose **I'll do this later**. Bridge now says "Connect your books to begin".
6. Leave that tab open. Don't import yet: the import is the first live moment.

Never edit the database, never import twice to "warm it up", and never reuse yesterday's account. Yesterday's overdue days are wrong today.

## The 7 minutes

| Time | Click | You see | Say |
|---|---|---|---|
| 0:00 | Bridge (empty) | "Connect your books to begin" | "Starlane only reports from a company's own books. Here is a distributor with 12 customers." |
| 0:45 | **Upload a file** → choose `Apex-Bills-Receivable.xlsx` | Every column matched: Party's Name, Ref. No., Date, Due on, Pending Amount | "This is the Bills Receivable report straight out of Tally. Nobody mapped anything." |
| 1:00 | **Import and analyse** | "What Starlane found: I read 29 invoices from 12 customers… 5 decisions need you." | "Seconds after import it has already found what needs a decision." |
| 1:30 | Bridge | "5 decisions waiting on you, 7 urgent changes on Watch". Business state: ₹47,21,600 owed, ₹29,97,000 overdue, ₹7,41,200 over 90 days | "Every number is a sum of the invoices you just saw. Check them against the sheet." |
| 2:30 | **Watch** → open *Narmada Valves… AIS/26-27/2401* | ₹6,85,000, due 22 Jun, 119 days overdue, each line marked Fact or Calculated, from File import | "Starlane isn't guessing. Every alert names the invoice and how each number was worked out." |
| 3:15 | Bridge → **Decide** on *How should we recover ₹16.36L from Narmada Valves…* | ₹8.32L at stake, cost of waiting a week, confidence **Unknown**, why now (48% of all receivables sit with this customer), 5 options including doing nothing | "It says Unknown because this company has no payment history yet. It won't invent confidence." |
| 3:45 | **View evidence** | 9 items: the 3 invoices, the calculations with formulas, 13 assumptions | "You can challenge every figure." |
| 4:30 | **Simulate** | "Under pressure": the best choice if the customer pays as before, 25% faster, 33% slower or half as fast. Drag "Try a what-if" to 0.5× and press Simulate: it says whether the recommendation holds. Each option's range against doing nothing | "This is what changes if we act, what if we don't, and what if we're wrong about the customer." |
| 5:15 | **Handle it** | "Mission started in shadow mode. Nothing was changed outside Starlane." Next steps: *Put the customer on advance payment*, *Prepare a firm reminder for your approval*, both Recorded only | "Starlane turns the decision into steps, and while shadow mode is on it records what it would do without touching anything outside Starlane." |
| 6:00 | **Missions** | The mission in *Checking the outcome*, 2 of 2 steps done | "It now watches the books to see whether the money actually comes in." |
| 6:30 | **Memory** | Empty, with the reason | "Memory fills only from outcomes it has checked. A day-old company has none, and Starlane says so instead of making it up." |

Optional, if asked: **Control** shows L1 Observe to L4 Execute, and L4 needs your approval every time.

## What not to do

- Don't say Starlane sent a message or called anyone. In shadow mode it records the step only.
- Don't click **Ask Starlane** unless `demo:readiness --full` showed CHAT passing. Without a model key it says it isn't set up yet, which is honest but not a good demo.
- Don't promise payment predictions. Confidence is Unknown until there is payment history.
- Don't import the CSV and the XLSX into the same account. They are the same bills.

## If something fails during the meeting

| Symptom | What to do |
|---|---|
| The sign-up code doesn't arrive | Use the account you made in the morning. If no code ever arrives, sign-up email isn't configured on production (see `PRODUCTION_RUNBOOK.md`). |
| The upload shows an error | Read the message out: it names the problem. Switch to the local fallback. |
| Bridge shows no decisions after 30 seconds | Open **Decisions**. If it is empty too, switch to the local fallback and report the run. |
| The website doesn't load | Switch to the local fallback. Don't keep retrying in front of the customer. |

## Local fallback (same code, same flow)

On a laptop with Node 20 and PostgreSQL 16:

```bash
# backend
cd vantro-flow-backend
cp .env.example .env            # set DATABASE_URL, JWT_SECRET (32+ chars), PUBLIC_LINK_SECRET,
                                 # RESEND_API_KEY and EMAIL_FROM (the same sender as production)
npm ci && npm run db:migrate
npm run demo:dataset
npm start                        # http://localhost:4000

# frontend (second terminal)
cd vantro-flow-frontend
npm ci
NEXT_PUBLIC_API_URL=http://localhost:4000 npm run dev -- -p 3000
```

Sign-up codes go out by email even locally, so the fallback needs `RESEND_API_KEY` and `EMAIL_FROM`; without them nobody can sign up, and the backend logs only that delivery isn't configured (never the code). Make the fallback's Apex account the same morning, through the local sign-up form, and leave onboarding for later. Then run `npm run demo:readiness -- --api http://localhost:4000 --site http://localhost:3000`.
