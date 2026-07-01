# REV77 Client Health Score

Automated client health scoring system for REV77 digital marketing.

## Stack
- **Backend:** Node.js + Express
- **Database:** PostgreSQL (Supabase)
- **Hosting:** Render
- **Frontend:** Vanilla HTML/CSS/JS (no framework needed)

## Local setup

```bash
npm install
cp .env.example .env
# Add your Supabase DATABASE_URL to .env
node server.js
```

Visit `http://localhost:3000`

## Deploy to Render

1. Push to GitHub
2. New Web Service on Render → connect repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add `DATABASE_URL` environment variable (Supabase Transaction Pooler URL)

## Database setup

Run `schema.sql` in your Supabase SQL editor once — it creates all tables and seeds Tom's Mechanical as the first client.

## Scoring model

- **Campaign Performance (40%):** TapClicks data — Tier 1 trend metrics + keyword rankings
- **Delivery / Execution (25%):** Asana — coming soon
- **Client Communication (20%):** Manual input (Outlook automation planned)
- **Strategic / Account Risk (15%):** Client Master DB — coming soon

See `scoring.js` for the full scoring engine.
