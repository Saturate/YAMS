export class ApiError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

export class AuthError extends ApiError {
	constructor(message = "Authorization required.") {
		super(401, message);
	}
}

export class SetupRequiredError extends ApiError {
	constructor() {
		super(503, "Server not configured.");
	}
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
	const res = await fetch(path, {
		credentials: "same-origin",
		...options,
		headers: {
			"Content-Type": "application/json",
			...options.headers,
		},
	});

	if (res.status === 401) throw new AuthError();
	if (res.status === 503) throw new SetupRequiredError();

	const data = await res.json();

	if (!res.ok) {
		throw new ApiError(res.status, data.error ?? "Something went wrong.");
	}

	return data as T;
}

export interface SetupResponse {
	id: string;
	username: string;
}

export type UserRole = "admin" | "user";

export interface LoginResponse {
	username: string;
	role: UserRole;
}

export interface User {
	id: string;
	username: string;
	role: UserRole;
	oauth_provider: string | null;
	avatar_url: string | null;
	created_at: string;
	key_count: number;
}

export interface AuthProviders {
	github: boolean;
}

export interface Invite {
	id: string;
	email: string;
	role: UserRole;
	created_at: string;
	expires_at: string;
	used_at: string | null;
}

export interface CreateInviteResponse {
	id: string;
	email: string;
	role: UserRole;
	token: string;
	invite_url: string;
	expires_at: string;
}

export interface ValidateInviteResponse {
	email: string;
	role: UserRole;
}

export interface ApiKey {
	id: string;
	label: string;
	key_prefix: string;
	is_active: boolean;
	expires_at: string | null;
	created_at: string;
	last_used_at: string | null;
}

export interface CreateKeyResponse {
	id: string;
	key: string;
	label: string;
	key_prefix: string;
	expires_at: string | null;
}

export interface Memory {
	id: string;
	api_key_id: string;
	git_remote: string | null;
	scope: string;
	summary: string;
	metadata: string | null;
	created_at: string;
}

export interface MemoriesResponse {
	memories: Memory[];
	total: number;
}

export interface StatsResponse {
	memories: number;
	keys: { total: number; active: number };
	projects: number;
	sessions: { total: number; active: number };
	workspaces: number;
}

export interface Workspace {
	id: string;
	name: string;
	created_by: string;
	created_at: string;
	project_count: number;
}

export interface WorkspaceDetail extends Workspace {
	projects: string[];
}

export interface WorkspacesResponse {
	workspaces: Workspace[];
}

export interface FiltersResponse {
	projects: string[];
	scopes: string[];
}

export interface SearchResult {
	score: number;
	id: string;
	api_key_id: string;
	git_remote: string | null;
	scope: string;
	summary: string;
	metadata: string | null;
	created_at: string;
}

export interface SearchResponse {
	results: SearchResult[];
}

export interface Session {
	id: string;
	claude_session_id: string;
	api_key_id: string;
	project: string | null;
	status: string;
	summary: string | null;
	started_at: string;
	ended_at: string | null;
	observation_count: number;
}

export interface SessionsResponse {
	sessions: Session[];
	total: number;
}

export interface Observation {
	id: string;
	session_id: string;
	event: string;
	tool_name: string | null;
	content: string;
	compressed: number;
	created_at: string;
}

export interface SessionDetailResponse {
	session: Session;
	observations: Observation[];
}

export interface SettingsResponse {
	settings: Record<string, string | null>;
}

export interface HooksConfigResponse {
	hooks: Record<string, unknown>;
}

export interface GraphNode {
	id: string;
	summary: string;
	scope: string;
	project: string | null;
	created_at: string;
}

export interface GraphEdge {
	id: string;
	source: string;
	target: string;
	edge_type: string;
	metadata: Record<string, unknown> | null;
	created_at: string;
}

export interface GraphResponse {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export const api = {
	setup(username: string, password: string) {
		return request<SetupResponse>("/setup", {
			method: "POST",
			body: JSON.stringify({ username, password }),
		});
	},

	login(username: string, password: string) {
		return request<LoginResponse>("/api/auth/login", {
			method: "POST",
			body: JSON.stringify({ username, password }),
		});
	},

	logout() {
		return request<{ ok: true }>("/api/auth/logout", {
			method: "POST",
		});
	},

	me() {
		return request<{ username: string; role: UserRole }>("/api/auth/me");
	},

	listKeys() {
		return request<ApiKey[]>("/api/keys");
	},

	createKey(label: string, expiresInDays?: number) {
		const body: { label: string; expires_in?: number } = { label };
		if (expiresInDays != null) {
			body.expires_in = expiresInDays * 86400;
		}
		return request<CreateKeyResponse>("/api/keys", {
			method: "POST",
			body: JSON.stringify(body),
		});
	},

	revokeKey(id: string) {
		return request<{ id: string; revoked: true }>(`/api/keys/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
	},

	getStats() {
		return request<StatsResponse>("/api/admin/stats");
	},

	getFilters() {
		return request<FiltersResponse>("/api/admin/filters");
	},

	listMemories(opts?: {
		git_remote?: string;
		scope?: string;
		limit?: number;
		offset?: number;
	}) {
		const params = new URLSearchParams();
		if (opts?.git_remote) params.set("git_remote", opts.git_remote);
		if (opts?.scope) params.set("scope", opts.scope);
		if (opts?.limit) params.set("limit", String(opts.limit));
		if (opts?.offset) params.set("offset", String(opts.offset));
		const qs = params.toString();
		return request<MemoriesResponse>(`/api/admin/memories${qs ? `?${qs}` : ""}`);
	},

	searchMemories(query: string, opts?: { git_remote?: string; scope?: string; limit?: number }) {
		return request<SearchResponse>("/api/admin/search", {
			method: "POST",
			body: JSON.stringify({ query, ...opts }),
		});
	},

	deleteMemory(id: string) {
		return request<{ id: string; deleted: true }>(`/api/admin/memories/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
	},

	// --- Auth providers ---

	getAuthProviders() {
		return request<AuthProviders>("/api/auth/providers");
	},

	// --- User management (admin) ---

	listUsers() {
		return request<User[]>("/api/users");
	},

	createUser(username: string, password: string, role?: UserRole) {
		return request<{ id: string; username: string; role: UserRole }>("/api/users", {
			method: "POST",
			body: JSON.stringify({ username, password, role }),
		});
	},

	deleteUserAccount(id: string) {
		return request<{ id: string; deleted: true }>(`/api/users/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
	},

	// --- Invites (admin) ---

	createInvite(email: string, opts?: { role?: UserRole; expires_in_days?: number }) {
		return request<CreateInviteResponse>("/api/invites", {
			method: "POST",
			body: JSON.stringify({ email, ...opts }),
		});
	},

	listInvites() {
		return request<Invite[]>("/api/invites");
	},

	deleteInvite(id: string) {
		return request<{ id: string; deleted: true }>(`/api/invites/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
	},

	// --- Invites (public) ---

	validateInvite(token: string) {
		return request<ValidateInviteResponse>(`/api/invites/${encodeURIComponent(token)}/validate`);
	},

	acceptInvite(token: string, username: string, password: string) {
		return request<{ id: string; username: string; role: UserRole }>(
			`/api/invites/${encodeURIComponent(token)}/accept`,
			{
				method: "POST",
				body: JSON.stringify({ username, password }),
			},
		);
	},

	// --- Sessions ---

	listSessions(opts?: {
		project?: string;
		status?: string;
		limit?: number;
		offset?: number;
	}) {
		const params = new URLSearchParams();
		if (opts?.project) params.set("project", opts.project);
		if (opts?.status) params.set("status", opts.status);
		if (opts?.limit) params.set("limit", String(opts.limit));
		if (opts?.offset) params.set("offset", String(opts.offset));
		const qs = params.toString();
		return request<SessionsResponse>(`/api/admin/sessions${qs ? `?${qs}` : ""}`);
	},

	getSession(id: string) {
		return request<SessionDetailResponse>(`/api/admin/sessions/${encodeURIComponent(id)}`);
	},

	deleteSession(id: string) {
		return request<{ id: string; deleted: true }>(`/api/admin/sessions/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
	},

	// --- Settings ---

	getSettings() {
		return request<SettingsResponse>("/api/admin/settings");
	},

	updateSettings(settings: Record<string, string | null>) {
		return request<{ ok: true }>("/api/admin/settings", {
			method: "PUT",
			body: JSON.stringify(settings),
		});
	},

	// --- Hooks config ---

	getHooksConfig(keyId: string) {
		return request<HooksConfigResponse>(`/api/keys/${encodeURIComponent(keyId)}/hooks-config`);
	},

	// --- Graph ---

	getGraph(opts?: { project?: string; scope?: string; limit?: number }) {
		const params = new URLSearchParams();
		if (opts?.project) params.set("project", opts.project);
		if (opts?.scope) params.set("scope", opts.scope);
		if (opts?.limit) params.set("limit", String(opts.limit));
		const qs = params.toString();
		return request<GraphResponse>(`/api/graph${qs ? `?${qs}` : ""}`);
	},

	// --- Workspaces ---

	listWorkspaces() {
		return request<WorkspacesResponse>("/api/admin/workspaces");
	},

	createWorkspace(name: string) {
		return request<{ id: string; name: string }>("/api/admin/workspaces", {
			method: "POST",
			body: JSON.stringify({ name }),
		});
	},

	getWorkspace(id: string) {
		return request<WorkspaceDetail>(`/api/admin/workspaces/${encodeURIComponent(id)}`);
	},

	updateWorkspace(id: string, name: string) {
		return request<{ ok: true }>(`/api/admin/workspaces/${encodeURIComponent(id)}`, {
			method: "PUT",
			body: JSON.stringify({ name }),
		});
	},

	deleteWorkspace(id: string) {
		return request<{ id: string; deleted: true }>(
			`/api/admin/workspaces/${encodeURIComponent(id)}`,
			{ method: "DELETE" },
		);
	},

	assignProjectToWorkspace(workspaceId: string, gitRemote: string) {
		return request<{ workspace_id: string; git_remote: string }>(
			`/api/admin/workspaces/${encodeURIComponent(workspaceId)}/projects`,
			{
				method: "POST",
				body: JSON.stringify({ git_remote: gitRemote }),
			},
		);
	},

	removeProjectFromWorkspace(workspaceId: string, gitRemote: string) {
		return request<{ git_remote: string; deleted: true }>(
			`/api/admin/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(gitRemote)}`,
			{ method: "DELETE" },
		);
	},
};
