# Clarifact — Chrome Extension Fact-Checker

> **Fact-check any selected text on any webpage.**  
> Pure programmatic approach — Brave Search API + NLP. No AI APIs. No LLMs.

---

## What It Does

1. You select text on any webpage (or right-click → "Fact-check with Clarifact")
2. The extension searches Brave Search for the claim
3. It scrapes and parses the top 5 results with Readability.js
4. It extracts named entities (people, places, orgs, dates) with compromise.js
5. It computes sentence similarity between the claim and each source
6. It detects contradictions using negation analysis
7. A confidence score (0–100%) and verdict (SUPPORTED / INCONCLUSIVE / CONTRADICTED) are shown in a sidebar

---

## Project Structure

```
clarifact/
├── backend/          Node.js/Express proxy (hides API key, scrapes pages)
└── extension/        Chrome Extension (Manifest V3)
```

---

## Prerequisites

- **Node.js** v18 or higher — https://nodejs.org
- **Google Chrome** (or Chromium)
- **Brave Search API key** (free tier) — https://brave.com/search/api/

---

## Step 1 — Get Your Brave Search API Key

1. Go to https://brave.com/search/api/
2. Click **"Get Started for Free"**
3. Create an account and subscribe to the **Free tier** (2,000 queries/month)
4. Go to **API Keys** in your dashboard
5. Copy your API key — it starts with `BSA...`

---

## Step 2 — Set Up the Backend

```powershell
# From the project root:
cd backend
npm install

# Copy the example env file
copy .env.example .env
```

Open `backend\.env` in any text editor and replace the placeholder:

```
BRAVE_API_KEY=BSAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
PORT=3000
```

---

## Step 3 — Run the Backend

```powershell
# Development (auto-restart on file changes):
npm run dev

# Production:
npm start
```

You should see:

```
╔════════════════════════════════════════════════╗
║         Clarifact Backend — Running            ║
║  http://127.0.0.1:3000                        ║
║  API Key: ✓ configured                        ║
╚════════════════════════════════════════════════╝
```

Verify it works:

```powershell
# Should return { status: "ok", apiKeyConfigured: true }
curl http://127.0.0.1:3000/health

# Test a search
curl -X POST http://127.0.0.1:3000/api/search `
  -H "Content-Type: application/json" `
  -d '{"query":"Neil Armstrong moon landing 1969","count":5}'
```

---

## Step 4 — Set Up the Extension Libraries

```powershell
cd ..\extension
npm install
```

This automatically copies `compromise.js` into `extension\lib\`.  
You should see:

```
[setup] ✓ Copied compromise.js → lib/ (XXX KB)
[setup] ✓ All libraries ready.
```

---

## Step 5 — Load the Extension in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Enable **"Developer mode"** (toggle in the top-right)
3. Click **"Load unpacked"**
4. Browse to and select the `extension\` folder (the one containing `manifest.json`)
5. The Clarifact extension will appear with its icon in the toolbar

> **Important:** The extension ID shown on `chrome://extensions` is unique to your machine.  
> You do not need to configure it anywhere for local use.

---

## Step 6 — Test the Pipeline End-to-End

Open any news article or Wikipedia page. Select some text, then:

**Method A:** Click the purple **"✓ Fact-check"** button that appears near your selection  
**Method B:** Right-click the selected text → **"🔍 Fact-check with Clarifact"**

### Recommended Test Claims

| Claim to select | Expected verdict | Why |
|---|---|---|
| `Neil Armstrong became the first human to walk on the Moon on July 20, 1969` | **SUPPORTED** | Extremely well-documented, many high-trust sources |
| `The Great Wall of China is visible from space with the naked eye` | **INCONCLUSIVE** | Debated — some sources confirm the myth, others correct it |
| `COVID-19 vaccines contain microchips implanted by the government` | **CONTRADICTED** | Well-refuted claim, negation sentences dominate results |

---

## Architecture Overview

```
[User selects text]
       │
       ▼
[content.js]  ── FACT_CHECK_REQUEST ──▶  [background.js]
                                                │
                                    POST /api/search (Brave API)
                                                │
                                    POST /api/scrape ×5 (parallel)
                                         │ Readability.js on backend
                                                │
                    SEARCH_RESULTS_READY ◀──────┘
                          │
               [content.js NLP pipeline]
                  compromise.js entities
                  TF cosine similarity
                  negation contradiction detection
                          │
               [scorer.js] → confidence score
                          │
               [sidebar rendered in-page]
```

---

## Development Tips

- **Backend logs** all scrape calls — watch the terminal for `[scrape] OK` or `[scrape] Failed`
- **Extension console logs** appear in Chrome DevTools → the tab's console (for content.js) or `chrome://extensions` → Inspect views → Service Worker (for background.js)
- After editing any extension file, go to `chrome://extensions` and click **⟳ Reload** on the Clarifact card
- The backend does **not** need to be restarted when you edit extension files

---

## Known Limitations (v1.0)

- **SPAs (React/Vue):** Backend fetches raw HTML — JavaScript-rendered content may be incomplete
- **Hard paywalls:** WSJ, FT, and similar sites are blocked — skipped with a warning
- **Rate limits:** Brave free tier is 2,000 searches/month — results are not cached in v1
- **Non-English claims:** NLP accuracy is reduced; a warning is shown
- **PDF links:** Automatically skipped (Readability cannot parse binary files)

---

## License

MIT
