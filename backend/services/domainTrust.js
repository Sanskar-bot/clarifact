/**
 * domainTrust.js — Domain reputation score lookup
 *
 * Returns a trust score (0.0 – 1.0) for a given domain name.
 * The score is used as one of four signals in the final confidence calculation.
 *
 * Scoring tiers:
 *   0.90–0.97  Major news wires, peer-reviewed journals, government health agencies
 *   0.80–0.89  Established newspapers, public broadcasting, fact-checkers
 *   0.65–0.79  Wikipedia, history sites, general reference
 *   0.40–0.64  Medium, Substack, YouTube (varies by author)
 *   0.20–0.39  Social media, blogs, anonymous forums
 *   0.40       Unknown domains (default)
 */

const domainMap = require("../data/trustedDomains.json");

/**
 * getDomainTrust
 * @param {string} domain - Raw domain string (may include "www." prefix)
 * @returns {number} Trust score between 0.0 and 1.0
 */
function getDomainTrust(domain) {
  // Strip www. prefix for consistent lookup
  const clean = domain.replace(/^www\./, "").toLowerCase().trim();

  // Exact match first
  if (domainMap[clean] !== undefined) {
    return domainMap[clean];
  }

  // TLD-based heuristics for unknown domains — government and academic institutions
  // are generally reliable even if not in our curated list
  if (clean.endsWith(".gov")) return 0.90;
  if (clean.endsWith(".edu")) return 0.82;
  if (clean.endsWith(".ac.uk")) return 0.82;
  if (clean.endsWith(".ac.in")) return 0.78;
  if (clean.endsWith(".org")) return 0.58; // .org can be anything, modest bump

  // Check if the domain is a subdomain of a known trusted domain
  // e.g., "health.reuters.com" should inherit reuters.com trust
  const parts = clean.split(".");
  if (parts.length > 2) {
    const parentDomain = parts.slice(-2).join(".");
    if (domainMap[parentDomain] !== undefined) {
      // Slight penalty for subdomains — can't guarantee editorial standards
      return Math.max(domainMap[parentDomain] - 0.05, 0.10);
    }
  }

  // Completely unknown domain — use default
  return domainMap["unknown"];
}

module.exports = { getDomainTrust };
