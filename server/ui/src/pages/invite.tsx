import { ApiError, api } from "@/api";
import { useAuth } from "@/auth-context";
import { AuthLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useNavigate, useParams } from "react-router";

export function InvitePage() {
	const { token } = useParams<{ token: string }>();
	const navigate = useNavigate();
	const { login } = useAuth();
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);

	const inviteQuery = useQuery({
		queryKey: ["invite", token],
		queryFn: () => {
			if (!token) throw new Error("unreachable");
			return api.validateInvite(token);
		},
		enabled: Boolean(token),
		retry: false,
	});

	async function handleSubmit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		if (!token) return;

		setError("");
		setLoading(true);

		const form = new FormData(e.currentTarget);
		const username = (form.get("username") as string).trim();
		const password = form.get("password") as string;

		try {
			const result = await api.acceptInvite(token, username, password);
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

	if (inviteQuery.isLoading) {
		return (
			<AuthLayout title="YAMS" description="Validating invite...">
				<p className="text-sm text-muted-foreground">Loading...</p>
			</AuthLayout>
		);
	}

	if (inviteQuery.isError) {
		const msg =
			inviteQuery.error instanceof ApiError
				? inviteQuery.error.message
				: "Invalid or expired invite link.";
		return (
			<AuthLayout title="YAMS" description="Invite">
				<div className="rounded-md border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-400">
					{msg}
				</div>
				<Button className="mt-4 w-full" variant="outline" onClick={() => navigate("/login")}>
					Go to login
				</Button>
			</AuthLayout>
		);
	}

	const invite = inviteQuery.data;

	return (
		<AuthLayout title="YAMS" description="Create your account">
			<div className="mb-4 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
				Invited as <strong>{invite?.email}</strong>
			</div>
			<form onSubmit={handleSubmit} className="space-y-4">
				<div className="space-y-2">
					<Label htmlFor="username">Username</Label>
					<Input id="username" name="username" required minLength={3} autoComplete="username" />
				</div>
				<div className="space-y-2">
					<Label htmlFor="password">Password</Label>
					<Input
						id="password"
						name="password"
						type="password"
						required
						minLength={8}
						autoComplete="new-password"
					/>
				</div>
				{error && <p className="text-sm text-destructive-foreground">{error}</p>}
				<Button type="submit" className="w-full" disabled={loading}>
					{loading ? "Creating account..." : "Create account"}
				</Button>
			</form>
		</AuthLayout>
	);
}
