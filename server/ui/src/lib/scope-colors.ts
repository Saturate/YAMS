const SCOPE_CSS_VAR: Record<string, string> = {
	session: "--chart-1",
	project: "--chart-2",
	global: "--chart-3",
};

const FALLBACK_VAR = "--chart-4";

export function scopeColor(scope: string): string {
	return `var(${SCOPE_CSS_VAR[scope] ?? FALLBACK_VAR})`;
}

export function resolvedScopeColor(scope: string): string {
	const varName = SCOPE_CSS_VAR[scope] ?? FALLBACK_VAR;
	return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || "#888";
}
