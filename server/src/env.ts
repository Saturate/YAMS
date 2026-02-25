export interface ValidatedApiKey {
	id: string;
	user_id: string;
	label: string;
	key_prefix: string;
	is_active: number;
	expires_at: string | null;
	created_at: string;
	last_used_at: string | null;
}

export type AppEnv = {
	Variables: {
		userId: string;
		username: string;
		apiKey: ValidatedApiKey;
	};
};
