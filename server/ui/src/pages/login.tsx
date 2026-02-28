import { ApiError, api } from "@/api";
import { useAuth } from "@/auth-context";
import { AuthLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { randomBackronym } from "@/yams";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

const OAUTH_ERRORS: Record<string, string> = {
	oauth_failed: "GitHub authentication failed. Please try again.",
	org_restricted: "Your GitHub account is not in an allowed organization.",
};

export function LoginPage() {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const { login } = useAuth();
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);

	const showSetupSuccess = searchParams.get("setup") === "success";
	const oauthError = searchParams.get("error");
	const acronym = useMemo(() => randomBackronym(), []);

	const providersQuery = useQuery({
		queryKey: ["auth-providers"],
		queryFn: () => api.getAuthProviders(),
		staleTime: 300_000,
	});

	const githubEnabled = providersQuery.data?.github ?? false;

	async function handleSubmit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		setError("");
		setLoading(true);

		const form = new FormData(e.currentTarget);
		const username = (form.get("username") as string).trim();
		const password = form.get("password") as string;

		try {
			const result = await api.login(username, password);
			login(result.username, result.role);
			navigate("/dashboard");
		} catch (err) {
			if (err instanceof ApiError) {
				setError(err.message);
			} else {
				setError("Network error.");
			}
		} finally {
			setLoading(false);
		}
	}

	return (
		<AuthLayout title="YAMS" description={acronym}>
			{showSetupSuccess && (
				<div className="mb-4 rounded-md border border-green-800 bg-green-950 px-3 py-2 text-sm text-green-400">
					Admin account created. Sign in to continue.
				</div>
			)}
			{oauthError && (
				<div className="mb-4 rounded-md border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-400">
					{OAUTH_ERRORS[oauthError] ?? "Authentication failed."}
				</div>
			)}
			<form onSubmit={handleSubmit} className="space-y-4">
				<div className="space-y-2">
					<Label htmlFor="username">Username</Label>
					<Input id="username" name="username" required autoComplete="username" />
				</div>
				<div className="space-y-2">
					<Label htmlFor="password">Password</Label>
					<Input
						id="password"
						name="password"
						type="password"
						required
						autoComplete="current-password"
					/>
				</div>
				{error && <p className="text-sm text-destructive-foreground">{error}</p>}
				<Button type="submit" className="w-full" disabled={loading}>
					{loading ? "Signing in..." : "Sign in"}
				</Button>
			</form>
			{githubEnabled && (
				<>
					<div className="relative my-4">
						<div className="absolute inset-0 flex items-center">
							<span className="w-full border-t" />
						</div>
						<div className="relative flex justify-center text-xs uppercase">
							<span className="bg-card px-2 text-muted-foreground">or</span>
						</div>
					</div>
					<Button variant="outline" className="w-full" asChild>
						<a href="/api/auth/github">
							<svg
								className="mr-2 h-4 w-4"
								viewBox="0 0 16 16"
								fill="currentColor"
								aria-hidden="true"
							>
								<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
							</svg>
							Sign in with GitHub
						</a>
					</Button>
				</>
			)}
		</AuthLayout>
	);
}
