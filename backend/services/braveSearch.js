/**
 * webSearch.js — Search service with two modes:
 *
 * MODE 1 — Tavily API (if TAVILY_API_KEY is set)
 *   Free tier: 1,000 searches/month, no credit card.
 *   Sign up: https://app.tavily.com/sign-up
 *   Best for: current events, news, recent facts.
 *
 * MODE 2 — Wikipedia API (automatic fallback, NO key required)
 *   Completely free, no signup, no rate limits for reasonable use.
 *   Best for: established facts, people, places, historical events.
 *   Limitation: will not find very recent news (last few days).
 *
 * Both modes return the same SearchResult shape so all downstream
 * code (routes/search.js, background.js) is unaffected.
 */

"use strict";

const fetch = require("node-fetch");

// Domains we never want to scrape (social media, video, paywalls)
const SKIP_DOMAINS = new Set([
  "twitter.com", "x.com", "facebook.com", "instagram.com",
  "tiktok.com", "linkedin.com", "pinterest.com", "snapchat.com",
  "youtube.com", "vimeo.com", "twitch.tv"
]);

// ── MODE 1: Tavily ─────────────────────────────────────────────────────────

async function searchTavily(apiKey, query, count, retries) {
  let attempt = 0;
  while (attempt < retries) {
    const res = await fetch("https://api.tavily.com/search", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key:             apiKey,
        query:               query,
        search_depth:        "basic",
        max_results:         Math.min(count, 10),
        include_answer:      false,
        include_raw_content: false
      })
    });

    if (res.status === 429) {
      attempt++;
      if (attempt >= retries) throw new Error("Tavily rate limit exceeded");
      const wait = Math.pow(2, attempt) * 1000;
      console.warn(`[search] Tavily rate limited — retrying in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }

    if (res.status === 401) {
      throw new Error("Tavily API key invalid. Check TAVILY_API_KEY in backend/.env");
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Tavily API error ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    return (data.results || [])
      .filter(r => {
        try {
          return !SKIP_DOMAINS.has(new URL(r.url).hostname.replace(/^www\./, ""));
        } catch { return false; }
      })
      .map(r => ({
        title:       r.title || "",
        url:         r.url,
        description: r.content || "",
        domain:      new URL(r.url).hostname.replace(/^www\./, ""),
        age:         null
      }));
  }
}

// ── MODE 2: Wikipedia free API ─────────────────────────────────────────────

/**
 * searchWikipedia
 * Uses Wikipedia's public API — no key, no rate limit for reasonable use.
 * Returns up to `count` Wikipedia article URLs for the query.
 */
async function searchWikipedia(query, count) {
  const searchUrl = new URL("https://en.wikipedia.org/w/api.php");
  searchUrl.searchParams.set("action",     "query");
  searchUrl.searchParams.set("list",       "search");
  searchUrl.searchParams.set("srsearch",   query);
  searchUrl.searchParams.set("srnamespace","0");
  searchUrl.searchParams.set("srlimit",    String(Math.min(count, 10)));
  searchUrl.searchParams.set("format",     "json");
  searchUrl.searchParams.set("origin",     "*");

  const res = await fetch(searchUrl.toString(), {
    headers: {
      "User-Agent": "Clarifact/1.1 (fact-checking extension; contact@clarifact.local)"
    }
  });

  if (!res.ok) {
    throw new Error(`Wikipedia search API error ${res.status}`);
  }

  const data = await res.json();
  const results = data?.query?.search || [];

  if (results.length === 0) {
    console.warn("[search] Wikipedia returned 0 results — try adding more specific terms");
    return [];
  }

  // Build article URLs from page titles
  return results.map(r => {
    const slug = encodeURIComponent(r.title.replace(/ /g, "_"));
    const url  = `https://en.wikipedia.org/wiki/${slug}`;
    // Strip HTML tags from snippet
    const description = (r.snippet || "").replace(/<[^>]+>/g, "").trim();
    return {
      title:       r.title,
      url,
      description,
      domain:      "en.wikipedia.org",
      age:         null
    };
  });
}

// ── Public entry point ─────────────────────────────────────────────────────

/**
 * searchWeb — auto-detects which mode to use based on environment.
 * @param {string} query
 * @param {number} [count=10]
 * @param {number} [retries=3]
 * @returns {Promise<SearchResult[]>}
 */
async function searchWeb(query, count = 10, retries = 3) {
  const tavilyKey = process.env.TAVILY_API_KEY;
  const useTavily = tavilyKey && tavilyKey !== "YOUR_TAVILY_API_KEY_HERE";

  if (useTavily) {
    console.log(`[search] Mode: Tavily API`);
    return searchTavily(tavilyKey, query, count, retries);
  }

  // Fallback: Wikipedia free API
  console.log("[search] Mode: Wikipedia API (free fallback — no key required)");
  console.log("[search] Tip: set TAVILY_API_KEY in .env for broader web search");
  return searchWikipedia(query, count);
}

// Backward-compat alias so existing require("./braveSearch") calls still work
module.exports = { searchWeb, searchBrave: searchWeb };
