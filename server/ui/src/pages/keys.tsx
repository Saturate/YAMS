import type { ApiKey, CreateKeyResponse } from "@/api";
import { api } from "@/api";
import { AppLayout } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { relativeTime } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";

function keyStatus(key: ApiKey): {
	label: string;
	variant: "default" | "secondary" | "destructive";
} {
	if (!key.is_active) return { label: "Revoked", variant: "destructive" };
	if (key.expires_at && new Date(key.expires_at) < new Date()) {
		return { label: "Expired", variant: "secondary" };
	}
	return { label: "Active", variant: "default" };
}

export function KeysPage() {
	const queryClient = useQueryClient();

	const [createOpen, setCreateOpen] = useState(false);
	const [createdKey, setCreatedKey] = useState<CreateKeyResponse | null>(null);
	const [copied, setCopied] = useState(false);

	const keysQuery = useQuery({
		queryKey: ["keys"],
		queryFn: () => api.listKeys(),
	});

	const createMutation = useMutation({
		mutationFn: (params: { label: string; days?: number }) =>
			api.createKey(params.label, params.days),
		onSuccess: (result) => {
			setCreatedKey(result);
			setCreateOpen(false);
			queryClient.invalidateQueries({ queryKey: ["keys"] });
		},
	});

	const revokeMutation = useMutation({
		mutationFn: (id: string) => api.revokeKey(id),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["keys"] }),
	});

	function handleCreate(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		const label = (form.get("label") as string).trim();
		const daysStr = (form.get("expires") as string).trim();
		const days = daysStr ? Number(daysStr) : undefined;
		createMutation.mutate({ label, days });
	}

	async function handleCopy(text: string) {
		await navigator.clipboard.writeText(text);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	}

	const keys = keysQuery.data ?? [];

	return (
		<AppLayout>
			<div className="mb-6 flex items-center justify-between">
				<h2 className="text-2xl font-semibold">API Keys</h2>

				<Dialog open={createOpen} onOpenChange={setCreateOpen}>
					<DialogTrigger asChild>
						<Button size="sm">
							<Plus className="mr-1 h-4 w-4" />
							Create Key
						</Button>
					</DialogTrigger>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>Create API Key</DialogTitle>
							<DialogDescription>Generate a new key for programmatic access.</DialogDescription>
						</DialogHeader>
						<form onSubmit={handleCreate} className="space-y-4">
							<div className="space-y-2">
								<Label htmlFor="label">Label</Label>
								<Input id="label" name="label" required placeholder="e.g. production" />
							</div>
							<div className="space-y-2">
								<Label htmlFor="expires">Expires in (days)</Label>
								<Input
									id="expires"
									name="expires"
									type="number"
									min={1}
									placeholder="Leave empty for no expiration"
								/>
							</div>
							{createMutation.isError && (
								<p className="text-sm text-destructive-foreground">
									{createMutation.error.message}
								</p>
							)}
							<DialogFooter>
								<DialogClose asChild>
									<Button type="button" variant="outline">
										Cancel
									</Button>
								</DialogClose>
								<Button type="submit" disabled={createMutation.isPending}>
									{createMutation.isPending ? "Creating..." : "Create"}
								</Button>
							</DialogFooter>
						</form>
					</DialogContent>
				</Dialog>
			</div>

			{/* Key created dialog */}
			<Dialog open={createdKey !== null} onOpenChange={(open) => !open && setCreatedKey(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Key Created</DialogTitle>
						<DialogDescription>Copy your API key now. It won't be shown again.</DialogDescription>
					</DialogHeader>
					{createdKey && (
						<div className="space-y-3">
							<div className="flex items-center gap-2">
								<code className="flex-1 rounded-md bg-muted px-3 py-2 text-sm break-all">
									{createdKey.key}
								</code>
								<Button
									size="icon"
									variant="outline"
									aria-label="Copy API key to clipboard"
									onClick={() => handleCopy(createdKey.key)}
								>
									<Copy className="h-4 w-4" />
								</Button>
							</div>
							{copied && <p className="text-sm text-muted-foreground">Copied to clipboard.</p>}
						</div>
					)}
					<DialogFooter>
						<Button onClick={() => setCreatedKey(null)}>Done</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{keysQuery.isLoading ? (
				<p className="text-sm text-muted-foreground">Loading...</p>
			) : keys.length === 0 ? (
				<div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12">
					<KeyRound className="mb-3 h-10 w-10 text-muted-foreground" />
					<p className="text-sm text-muted-foreground">No API keys yet.</p>
					<Button size="sm" className="mt-4" onClick={() => setCreateOpen(true)}>
						<Plus className="mr-1 h-4 w-4" />
						Create your first key
					</Button>
				</div>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Label</TableHead>
							<TableHead>Prefix</TableHead>
							<TableHead>Status</TableHead>
							<TableHead>Created</TableHead>
							<TableHead>Last Used</TableHead>
							<TableHead>Expires</TableHead>
							<TableHead className="w-[50px]" />
						</TableRow>
					</TableHeader>
					<TableBody>
						{keys.map((key) => {
							const status = keyStatus(key);
							return (
								<TableRow key={key.id}>
									<TableCell className="font-medium">{key.label}</TableCell>
									<TableCell>
										<code className="text-xs">{key.key_prefix}...</code>
									</TableCell>
									<TableCell>
										<Badge variant={status.variant}>{status.label}</Badge>
									</TableCell>
									<TableCell className="text-muted-foreground text-sm">
										{relativeTime(key.created_at)}
									</TableCell>
									<TableCell className="text-muted-foreground text-sm">
										{relativeTime(key.last_used_at)}
									</TableCell>
									<TableCell className="text-muted-foreground text-sm">
										{key.expires_at ? relativeTime(key.expires_at) : "Never"}
									</TableCell>
									<TableCell>
										{key.is_active && (
											<Button
												size="icon"
												variant="ghost"
												aria-label={`Revoke key ${key.label}`}
												disabled={revokeMutation.isPending}
												onClick={() => revokeMutation.mutate(key.id)}
											>
												<Trash2 className="h-4 w-4" />
											</Button>
										)}
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			)}
		</AppLayout>
	);
}
