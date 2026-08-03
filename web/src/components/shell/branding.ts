/**
 * White-label branding values (feature 029 — FR-023, decision 0028, Principle VI).
 *
 * ⚠️ **The point is that these are CONFIGURATION with a neutral default, not literals in a component.**
 * A hardcoded company name is the thing that would bite on a licence sale, and it bites quietly: it
 * looks fine in every screenshot until the wrong customer sees the wrong word.
 *
 * Colours are NOT here and never will be — those are CSS-variable tokens per brand (0028). This file
 * holds only the text a human reads in the shell chrome.
 *
 * ⓘ The default is deliberately a generic product descriptor, not a company: "Support CRM" names what
 * the software is, the way "Mail" or "Calendar" does. If a deployment wants its own name it sets one.
 */
export const PRODUCT_WORDMARK = process.env.NEXT_PUBLIC_PRODUCT_NAME || 'Support CRM';
