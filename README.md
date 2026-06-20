# Clarifact — AI-Powered Chrome Extension Fact-Checker

> **Fact-check any selected text on any webpage.**  
> Powered by Nvidia Nemotron Nano 3 30B via Amazon Bedrock + Tavily web search.

---

## What It Does

1. Select text on any webpage (or right-click → "🔍 Fact-check with Clarifact")
2. The backend searches the web via Tavily API (or Wikipedia as a free fallback)
3. It scrapes and parses the top sources with Readability.js
4. It runs NLP scoring (entity matching, cosine similarity, negation detection)
5. It sends the claim + sources to **Nvidia Nemotron Nano 3 30B** via Amazon Bedrock
6. A verdict (**SUPPORTED / INCONCLUSIVE / CONTRADICTED**) and AI explanation appear in a sidebar

---

## Project Structure

```
clarifact/
├── backend/          Node.js/Express local proxy server
│   ├── routes/       API route handlers (search, scrape, analyze, factcheck)
│   ├── services/     AI providers (Nemotron, Gemini, Bedrock/Claude), web search, scraper
│   ├── scripts/      Diagnostic utilities (check-aws-setup.js)
│   ├── server.js     Entry point
│   └── .env.example  Environment variable template
└── extension/        Chrome Extension (Manifest V3)
    ├── background.js  Service worker — orchestrates the pipeline
    ├── content.js     Sidebar UI injected into pages
    ├── popup.js       Extension popup (health check display)
    └── manifest.json
```

---

## Prerequisites

- **Node.js** v18 or higher — https://nodejs.org
- **Google Chrome** (or Chromium-based browser)
- **AWS Account** with IAM user that has `AmazonBedrockFullAccess`
- **Bedrock Model Access** — Nemotron Nano 3 30B must be enabled in your region

---

## Getting Started

### Step 1 — Clone and install dependencies

```powershell
git clone https://github.com/Sanskar-bot/clarifact.git
cd clarifact\backend
npm install

cd ..\extension
npm install   # copies compromise.js into extension\lib\
```

### Step 2 — Configure environment variables

```powershell
cd ..\backend
copy .env.example .env
```

Open `backend\.env` in any editor and fill in these values:

#### Required — AWS IAM credentials (for Nemotron)

1. Go to **AWS Console → IAM → Users → [your user] → Security credentials**
2. Click **"Create access key"** → choose "Application running outside AWS"
3. Copy the Key ID and Secret Access Key into `.env`:

```env
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=ap-south-1
AI_PROVIDER=nemotron
```

Make sure `AmazonBedrockFullAccess` is attached to your IAM user, and that **Nemotron Nano 3 30B** is enabled in **Bedrock Console → Model access**.

#### Optional — Tavily API key (for real web search)

Without Tavily, the app falls back to Wikipedia — fine for established facts, but won't find recent news.

1. Go to **https://app.tavily.com/sign-up** (free, no credit card)
2. Copy your API key into `.env`:

```env
TAVILY_API_KEY=tvly-...
```

### Step 3 — Verify the AWS connection

Before starting the server, confirm everything is wired up:

```powershell
npm run check-aws
```

Expected output:
```
─────────────────────────────────────────────
  Clarifact — AWS Bedrock Connection Check
─────────────────────────────────────────────
     Region:  ap-south-1
     Model:   nvidia.nemotron-nano-3-30b
     Key ID:  AKIARFIM... (20 chars)

  Sending test request to Bedrock...

  ✓  AWS Bedrock + Nemotron connection verified successfully

     Model response: "OK"
─────────────────────────────────────────────
```

If you see an error, the script will tell you exactly what to fix.

### Step 4 — Start the backend

```powershell
npm run dev        # Development — auto-restarts on file changes
# or
npm start          # Production
```

Expected banner:
```
╔════════════════════════════════════════════════════╗
║          Clarifact Backend — Running               ║
║  http://127.0.0.1:3000                            ║
║  Search:       ✓ Tavily API (free)               ║
║  AI Provider:  nemotron                            ║
║  Nemotron:     ✓ configured (IAM)                 ║
╚════════════════════════════════════════════════════╝
```

### Step 5 — Load the Chrome Extension

1. Open Chrome → go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **"Load unpacked"**
4. Select the `extension\` folder (the one containing `manifest.json`)
5. The Clarifact icon will appear in your toolbar

> After editing any extension file, click **⟳ Reload** on the Clarifact card in `chrome://extensions`.

### Step 6 — Test end-to-end

Open any news article or Wikipedia page. Select some text, then:

**Method A:** Click the purple **"✓ Fact-check"** floating button  
**Method B:** Right-click → "🔍 Fact-check with Clarifact"

#### Recommended test claims

| Claim | Expected verdict |
|---|---|
| `Neil Armstrong became the first human to walk on the Moon on July 20, 1969` | **SUPPORTED** |
| `The Great Wall of China is visible from space with the naked eye` | **INCONCLUSIVE** |
| `Drinking 8 glasses of water a day is a scientifically proven requirement` | **CONTRADICTED** |

---

## AI Provider Chain

The backend supports multiple AI providers with automatic fallback:

```
AI_PROVIDER=nemotron  →  always uses Nemotron (recommended)
AI_PROVIDER=auto      →  Nemotron → Gemini → Bedrock/Claude (in order)
AI_PROVIDER=gemini    →  always uses Google Gemini 1.5 Flash
AI_PROVIDER=bedrock   →  always uses Claude via bearer token
```

| Provider | Model | Auth | Cost |
|---|---|---|---|
| **Nemotron** (primary) | Nvidia Nemotron Nano 3 30B | IAM credentials | Paid per token |
| **Gemini** (secondary) | Gemini 1.5 Flash | API key | Free tier |
| **Bedrock/Claude** (fallback) | Claude 3.5 Sonnet v2 | Bearer token or IAM | Paid per token |

---

## API Endpoints

All endpoints accept and return `application/json`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Server + provider status |
| `POST` | `/api/search` | Web search (Tavily or Wikipedia) |
| `POST` | `/api/scrape` | Scrape and extract text from a URL |
| `POST` | `/api/analyze` | AI fact-check (main pipeline endpoint) |
| `POST` | `/api/factcheck` | Direct Nemotron fact-check with pre-formatted sources |

---

## Architecture

```
[User selects text]
       │
       ▼
[content.js] ── FACT_CHECK_REQUEST ──▶ [background.js service worker]
                                               │
                                   POST /api/search (Tavily / Wikipedia)
                                               │
                                   POST /api/scrape ×5 (parallel)
                                        │ Readability.js on backend
                                               │
                       SEARCH_RESULTS_READY ◀──┘
                             │
                  [content.js NLP pipeline]
                     compromise.js entities
                     TF cosine similarity
                     negation contradiction
                             │
                  POST /api/analyze ──▶ [analyzeService.js]
                                              │
                                   [nemotronAnalysis.js]
                                   Nvidia Nemotron via Bedrock
                                   ConverseCommand (IAM auth)
                                              │
                  [sidebar rendered in-page] ◀┘
```

---

## Development Tips

- **Backend logs** — watch the terminal for `[search]`, `[scrape]`, `[nemotron]` prefixes
- **Extension logs** — Chrome DevTools console (content.js) or `chrome://extensions` → Inspect → Service Worker (background.js)
- **Verify AWS** anytime — `npm run check-aws`
- **Nodemon** restarts the backend automatically when you save `.js` files; it does NOT watch `.env` (restart manually after `.env` changes)

---

## Known Limitations

- **SPAs (React/Vue):** Backend fetches raw HTML — JavaScript-rendered content may be incomplete
- **Hard paywalls:** WSJ, FT, etc. are skipped with a warning
- **Recent news without Tavily:** Wikipedia won't find articles from the last few days
- **Non-English claims:** NLP accuracy is reduced; a warning is shown
- **PDF links:** Automatically skipped (Readability cannot parse binary files)

---

## License

MIT
