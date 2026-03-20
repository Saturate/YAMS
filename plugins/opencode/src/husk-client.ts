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
