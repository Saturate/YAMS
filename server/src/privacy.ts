import { getConfig } from "./db.js";

const PRIVATE_TAG_RE = /<private>[\s\S]*?<\/private>/gi;
const MAX_REPLACEMENTS = 100;
const REDACTED = "[REDACTED]";

/**
 * Strip <private>...</private> tags and their content from text.
 * After MAX_REPLACEMENTS, stops stripping to bound work on pathological input.
 */
export function stripPrivateTags(text: string): string {
	let count = 0;
	const result = text.replace(PRIVATE_TAG_RE, (match) => {
		count++;
		if (count > MAX_REPLACEMENTS) return match;
		return "";
	});
	return result.trim();
}

// --- Configurable regex patterns ---

let cachedRaw: string | undefined;
let cachedPatterns: RegExp[] = [];

function getRedactPatterns(): RegExp[] {
	const raw = getConfig("privacy_patterns");
	if (raw === cachedRaw) return cachedPatterns;

	cachedRaw = raw;
	if (!raw) {
		cachedPatterns = [];
		return cachedPatterns;
	}

	const patterns: RegExp[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		try {
			patterns.push(new RegExp(trimmed, "gi"));
		} catch {
			// Skip invalid regex — don't break ingestion
		}
	}
	cachedPatterns = patterns;
	return cachedPatterns;
}

/**
 * Apply all privacy filters: <private> tags + configurable regex patterns.
 * Regex matches are replaced with [REDACTED].
 */
export function applyPrivacyFilters(text: string): string {
	let result = stripPrivateTags(text);
	const patterns = getRedactPatterns();
	for (const re of patterns) {
		re.lastIndex = 0;
		result = result.replace(re, REDACTED);
	}
	return result;
}

/** Reset cached patterns — call when config changes. */
export function resetPrivacyCache(): void {
	cachedRaw = undefined;
	cachedPatterns = [];
}
