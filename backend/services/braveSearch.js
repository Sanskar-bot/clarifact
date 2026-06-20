/**
 * braveSearch.js — DEPRECATED
 *
 * This file has been renamed to webSearch.js.
 * The Brave Search API is no longer used — the service now uses
 * Tavily API (if TAVILY_API_KEY is set) with Wikipedia as a free fallback.
 *
 * This stub exists only to avoid breaking any external code that may still
 * require("./braveSearch"). All active backend code imports from webSearch.js.
 *
 * @deprecated — use services/webSearch.js instead
 */

"use strict";

const { searchWeb } = require("./webSearch");

// Re-export under the old name for backward compatibility
module.exports = { searchBrave: searchWeb, searchWeb };
