import type { CreateInviteResponse, Invite, User, UserRole } from "@/api";
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
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
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
import { Copy, Link, Plus, Trash2, Users as UsersIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

export function UsersPage() {
	const queryClient = useQueryClient();
	const [createOpen, setCreateOpen] = useState(false);
	const [inviteOpen, setInviteOpen] = useState(false);
	const [inviteRole, setInviteRole] = useState<UserRole>("user");
	const [createdInvite, setCreatedInvite] = useState<CreateInviteResponse | null>(null);
	const [copied, setCopied] = useState(false);
	const [role, setRole] = useState<UserRole>("user");

	const usersQuery = useQuery({
		queryKey: ["users"],
		queryFn: () => api.listUsers(),
	});

	const invitesQuery = useQuery({
		queryKey: ["invites"],
		queryFn: () => api.listInvites(),
	});

	const createMutation = useMutation({
		mutationFn: (params: { username: string; password: string; role: UserRole }) =>
			api.createUser(params.username, params.password, params.role),
		onSuccess: () => {
			setCreateOpen(false);
			setRole("user");
			queryClient.invalidateQueries({ queryKey: ["users"] });
		},
	});

	const inviteMutation = useMutation({
		mutationFn: (params: { email: string; role: UserRole }) =>
			api.createInvite(params.email, { role: params.role }),
		onSuccess: (result) => {
			setInviteOpen(false);
			setInviteRole("user");
			setCreatedInvite(result);
			queryClient.invalidateQueries({ queryKey: ["invites"] });
		},
	});

	const deleteMutation = useMutation({
		mutationFn: (id: string) => api.deleteUserAccount(id),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users"] }),
	});

	const deleteInviteMutation = useMutation({
		mutationFn: (id: string) => api.deleteInvite(id),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["invites"] }),
	});

	function handleCreate(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		const username = (form.get("username") as string).trim();
		const password = form.get("password") as string;
		createMutation.mutate({ username, password, role });
	}

	function handleInvite(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		const email = (form.get("email") as string).trim();
		inviteMutation.mutate({ email, role: inviteRole });
	}

	async function handleCopy(text: string) {
		await navigator.clipboard.writeText(text);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	}

	function providerLabel(user: User): string {
		if (user.oauth_provider === "github") return "GitHub";
		return "Local";
	}

	function inviteStatus(invite: Invite): {
		label: string;
		variant: "default" | "secondary" | "destructive";
	} {
		if (invite.used_at) return { label: "Used", variant: "secondary" };
		if (new Date(invite.expires_at) < new Date())
			return { label: "Expired", variant: "destructive" };
		return { label: "Pending", variant: "default" };
	}

	const users = usersQuery.data ?? [];
	const pendingInvites = (invitesQuery.data ?? []).filter((i) => !i.used_at);

	return (
		<AppLayout>
			{/* Users section */}
			<div className="mb-6 flex items-center justify-between">
				<h2 className="text-2xl font-semibold">Users</h2>
				<div className="flex gap-2">
					<Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
						<DialogTrigger asChild>
							<Button size="sm" variant="outline">
								<Link className="mr-1 h-4 w-4" />
								Invite
							</Button>
						</DialogTrigger>
						<DialogContent>
							<DialogHeader>
								<DialogTitle>Send Invite</DialogTitle>
								<DialogDescription>
									Create an invite link locked to an email address.
								</DialogDescription>
							</DialogHeader>
							<form onSubmit={handleInvite} className="space-y-4">
								<div className="space-y-2">
									<Label htmlFor="invite-email">Email</Label>
									<Input
										id="invite-email"
										name="email"
										type="email"
										required
										placeholder="alice@example.com"
									/>
								</div>
								<div className="space-y-2">
									<Label htmlFor="invite-role">Role</Label>
									<Select value={inviteRole} onValueChange={(v) => setInviteRole(v as UserRole)}>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="user">User</SelectItem>
											<SelectItem value="admin">Admin</SelectItem>
										</SelectContent>
									</Select>
								</div>
								{inviteMutation.isError && (
									<p className="text-sm text-destructive-foreground">
										{inviteMutation.error.message}
									</p>
								)}
								<DialogFooter>
									<DialogClose asChild>
										<Button type="button" variant="outline">
											Cancel
										</Button>
									</DialogClose>
									<Button type="submit" disabled={inviteMutation.isPending}>
										{inviteMutation.isPending ? "Creating..." : "Create Invite"}
									</Button>
								</DialogFooter>
							</form>
						</DialogContent>
					</Dialog>

					<Dialog open={createOpen} onOpenChange={setCreateOpen}>
						<DialogTrigger asChild>
							<Button size="sm">
								<Plus className="mr-1 h-4 w-4" />
								Create User
							</Button>
						</DialogTrigger>
						<DialogContent>
							<DialogHeader>
								<DialogTitle>Create User</DialogTitle>
								<DialogDescription>Add a new user with local credentials.</DialogDescription>
							</DialogHeader>
							<form onSubmit={handleCreate} className="space-y-4">
								<div className="space-y-2">
									<Label htmlFor="username">Username</Label>
									<Input
										id="username"
										name="username"
										required
										minLength={3}
										placeholder="e.g. alice"
										autoComplete="off"
									/>
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
								<div className="space-y-2">
									<Label htmlFor="role">Role</Label>
									<Select value={role} onValueChange={(v) => setRole(v as UserRole)}>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="user">User</SelectItem>
											<SelectItem value="admin">Admin</SelectItem>
										</SelectContent>
									</Select>
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
			</div>

			{/* Invite link created dialog */}
			<Dialog
				open={createdInvite !== null}
				onOpenChange={(open) => !open && setCreatedInvite(null)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Invite Created</DialogTitle>
						<DialogDescription>
							Share this link with <strong>{createdInvite?.email}</strong>. It expires in 7 days.
						</DialogDescription>
					</DialogHeader>
					{createdInvite && (
						<div className="space-y-3">
							<div className="flex items-center gap-2">
								<code className="flex-1 rounded-md bg-muted px-3 py-2 text-sm break-all">
									{createdInvite.invite_url}
								</code>
								<Button
									size="icon"
									variant="outline"
									aria-label="Copy invite link to clipboard"
									onClick={() => handleCopy(createdInvite.invite_url)}
								>
									<Copy className="h-4 w-4" />
								</Button>
							</div>
							{copied && <p className="text-sm text-muted-foreground">Copied to clipboard.</p>}
						</div>
					)}
					<DialogFooter>
						<Button onClick={() => setCreatedInvite(null)}>Done</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{usersQuery.isLoading ? (
				<p className="text-sm text-muted-foreground">Loading...</p>
			) : users.length === 0 ? (
				<div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12">
					<UsersIcon className="mb-3 h-10 w-10 text-muted-foreground" />
					<p className="text-sm text-muted-foreground">No users found.</p>
				</div>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Username</TableHead>
							<TableHead>Role</TableHead>
							<TableHead>Auth</TableHead>
							<TableHead>Keys</TableHead>
							<TableHead>Created</TableHead>
							<TableHead className="w-[50px]" />
						</TableRow>
					</TableHeader>
					<TableBody>
						{users.map((user) => (
							<TableRow key={user.id}>
								<TableCell className="font-medium">
									<span className="flex items-center gap-2">
										{user.avatar_url && (
											<img src={user.avatar_url} alt="" className="h-6 w-6 rounded-full" />
										)}
										{user.username}
									</span>
								</TableCell>
								<TableCell>
									<Badge variant={user.role === "admin" ? "default" : "secondary"}>
										{user.role}
									</Badge>
								</TableCell>
								<TableCell className="text-sm text-muted-foreground">
									{providerLabel(user)}
								</TableCell>
								<TableCell className="text-sm text-muted-foreground">{user.key_count}</TableCell>
								<TableCell className="text-sm text-muted-foreground">
									{relativeTime(user.created_at)}
								</TableCell>
								<TableCell>
									<Button
										size="icon"
										variant="ghost"
										aria-label={`Delete user ${user.username}`}
										disabled={deleteMutation.isPending}
										onClick={() => deleteMutation.mutate(user.id)}
									>
										<Trash2 className="h-4 w-4" />
									</Button>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}

			{/* Pending invites section */}
			{pendingInvites.length > 0 && (
				<>
					<h3 className="mb-4 mt-10 text-lg font-semibold">Pending Invites</h3>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Email</TableHead>
								<TableHead>Role</TableHead>
								<TableHead>Status</TableHead>
								<TableHead>Expires</TableHead>
								<TableHead className="w-[50px]" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{pendingInvites.map((invite) => {
								const status = inviteStatus(invite);
								return (
									<TableRow key={invite.id}>
										<TableCell className="font-medium">{invite.email}</TableCell>
										<TableCell>
											<Badge variant="secondary">{invite.role}</Badge>
										</TableCell>
										<TableCell>
											<Badge variant={status.variant}>{status.label}</Badge>
										</TableCell>
										<TableCell className="text-sm text-muted-foreground">
											{relativeTime(invite.expires_at)}
										</TableCell>
										<TableCell>
											<Button
												size="icon"
												variant="ghost"
												aria-label={`Revoke invite for ${invite.email}`}
												disabled={deleteInviteMutation.isPending}
												onClick={() => deleteInviteMutation.mutate(invite.id)}
											>
												<Trash2 className="h-4 w-4" />
											</Button>
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				</>
			)}
		</AppLayout>
	);
}
