interface IngestPayload {
	summary: string;
	git_remote: string | null;
	scope: "session";
	metadata: {
		session_id: string;
		reason: string;
		cwd: string;
		files_edited: string[];
	};
}

interface ObservationPayload {
	session_id: string;
	event: string;
	tool_name?: string | null;
	cwd?: string | null;
	prompt?: string | null;
	tool_input?: unknown;
	tool_response?: string | null;
}

interface ObservationResponse {
	uncompressed_count?: number;
}

export async function checkHealth(url: string): Promise<boolean> {
	try {
		const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
		return res.ok;
	} catch {
		return false;
	}
}

export async function postIngest(url: string, key: string, payload: IngestPayload): Promise<void> {
	await fetch(`${url}/ingest`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(5000),
	});
}

export async function postObservation(
	url: string,
	key: string,
	payload: ObservationPayload,
): Promise<ObservationResponse> {
	try {
		const res = await fetch(`${url}/hooks/observation`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(2000),
		});
		if (res.ok) {
			return (await res.json()) as ObservationResponse;
		}
		return {};
	} catch {
		return {};
	}
}
