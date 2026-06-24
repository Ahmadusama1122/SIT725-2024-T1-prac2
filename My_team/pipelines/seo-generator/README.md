# SEO Content Generator

Generates a 1,500-word SEO blog post every Monday, targeting the next keyword in rotation.

## Schedule

Every **Monday at 9am Melbourne time (AEST)**.

## Keywords (rotates weekly)

1. AI receptionist for dental practices Australia
2. AI receptionist Melbourne small business
3. After-hours answering service Australia
4. AI phone answering service small business
5. AI receptionist vs answering service Australia
6. Best AI receptionist for law firms Australia
7. AI receptionist for physiotherapy clinics
8. How to never miss a business call Australia

## How it works

1. **Keyword selection** — Reads "SEO Keywords" sheet to find the next unwritten keyword. Cycles back to #1 when all are done.
2. **Article generation** — Claude writes a 1,500-word markdown blog post with H1, 5 H2 sections, FAQ, and CTA.
3. **File save** — Saves to `blog-posts/[keyword-slug].md`.
4. **Email delivery** — Sends the full article to ahmadusama200@gmail.com.
5. **Sheet update** — Marks the keyword as "Written" with date and file path.

## Google Sheets tab

**SEO Keywords** — Keyword, Status, Date, File Path

## Output

Blog posts are saved to the `blog-posts/` directory in the project root.

## Run

```bash
node systems/seo-generator/index.js --test
npm run seo-generator:test

node systems/seo-generator/index.js
npm run seo-generator
```

## Logs

- `logs/seo-generator.log`
- `logs/seo-generator-errors.log`
