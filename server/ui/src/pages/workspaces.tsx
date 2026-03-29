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
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

export function WorkspacesPage() {
	const queryClient = useQueryClient();
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [newName, setNewName] = useState("");
	const [assignRemote, setAssignRemote] = useState("");
	const [assignWorkspaceId, setAssignWorkspaceId] = useState<string | null>(null);

	const workspacesQuery = useQuery({
		queryKey: ["workspaces"],
		queryFn: () => api.listWorkspaces(),
	});

	const filtersQuery = useQuery({
		queryKey: ["filters"],
		queryFn: () => api.getFilters(),
	});

	const detailQuery = useQuery({
		queryKey: ["workspaces", "detail", expandedId],
		queryFn: () => {
			if (!expandedId) throw new Error("unreachable");
			return api.getWorkspace(expandedId);
		},
		enabled: expandedId !== null,
	});

	const createMutation = useMutation({
		mutationFn: (name: string) => api.createWorkspace(name),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["workspaces"] });
			setNewName("");
		},
	});

	const deleteMutation = useMutation({
		mutationFn: (id: string) => api.deleteWorkspace(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["workspaces"] });
			queryClient.invalidateQueries({ queryKey: ["stats"] });
			setExpandedId(null);
		},
	});

	const assignMutation = useMutation({
		mutationFn: ({ workspaceId, gitRemote }: { workspaceId: string; gitRemote: string }) =>
			api.assignProjectToWorkspace(workspaceId, gitRemote),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["workspaces"] });
			setAssignRemote("");
			setAssignWorkspaceId(null);
		},
	});

	const removeMutation = useMutation({
		mutationFn: ({ workspaceId, gitRemote }: { workspaceId: string; gitRemote: string }) =>
			api.removeProjectFromWorkspace(workspaceId, gitRemote),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["workspaces"] });
		},
	});

	const workspaces = workspacesQuery.data?.workspaces ?? [];
	const projects = filtersQuery.data?.projects ?? [];

	return (
		<AppLayout>
			<div className="mb-6 flex items-center justify-between">
				<h2 className="text-2xl font-semibold">Workspaces</h2>
				<Dialog>
					<DialogTrigger asChild>
						<Button size="sm">
							<Plus className="mr-1 h-4 w-4" /> New Workspace
						</Button>
					</DialogTrigger>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>Create Workspace</DialogTitle>
							<DialogDescription>
								Group related projects so memories can be shared across them.
							</DialogDescription>
						</DialogHeader>
						<div className="space-y-2">
							<Label htmlFor="ws-name">Name</Label>
							<Input
								id="ws-name"
								placeholder="e.g. client-a"
								value={newName}
								onChange={(e) => setNewName(e.target.value)}
							/>
						</div>
						<DialogFooter>
							<DialogClose asChild>
								<Button variant="ghost">Cancel</Button>
							</DialogClose>
							<DialogClose asChild>
								<Button
									disabled={!newName.trim() || createMutation.isPending}
									onClick={() => createMutation.mutate(newName.trim())}
								>
									Create
								</Button>
							</DialogClose>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</div>

			{workspacesQuery.isLoading ? (
				<p className="text-sm text-muted-foreground">Loading...</p>
			) : workspaces.length === 0 ? (
				<div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12">
					<p className="text-sm text-muted-foreground">
						No workspaces yet. Create one to group related projects.
					</p>
				</div>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead className="w-[30px]" />
							<TableHead>Name</TableHead>
							<TableHead>Projects</TableHead>
							<TableHead>Created</TableHead>
							<TableHead className="w-[50px]" />
						</TableRow>
					</TableHeader>
					<TableBody>
						{workspaces.map((ws) => (
							<>
								<TableRow key={ws.id}>
									<TableCell>
										<Button
											size="icon"
											variant="ghost"
											className="h-6 w-6"
											onClick={() => setExpandedId(expandedId === ws.id ? null : ws.id)}
										>
											{expandedId === ws.id ? (
												<ChevronUp className="h-4 w-4" />
											) : (
												<ChevronDown className="h-4 w-4" />
											)}
										</Button>
									</TableCell>
									<TableCell className="font-medium">{ws.name}</TableCell>
									<TableCell>
										<Badge variant="secondary">{ws.project_count}</Badge>
									</TableCell>
									<TableCell className="text-sm text-muted-foreground">
										{relativeTime(ws.created_at)}
									</TableCell>
									<TableCell>
										<Button
											size="icon"
											variant="ghost"
											aria-label="Delete workspace"
											disabled={deleteMutation.isPending}
											onClick={() => deleteMutation.mutate(ws.id)}
										>
											<Trash2 className="h-4 w-4" />
										</Button>
									</TableCell>
								</TableRow>
								{expandedId === ws.id && (
									<TableRow key={`${ws.id}-detail`}>
										<TableCell colSpan={5} className="bg-muted/50 p-4">
											{detailQuery.isLoading ? (
												<p className="text-sm text-muted-foreground">Loading...</p>
											) : (
												<div className="space-y-3">
													<div className="flex items-center justify-between">
														<p className="text-xs font-medium uppercase text-muted-foreground">
															Assigned Projects
														</p>
														<Dialog
															open={assignWorkspaceId === ws.id}
															onOpenChange={(open) => setAssignWorkspaceId(open ? ws.id : null)}
														>
															<DialogTrigger asChild>
																<Button size="sm" variant="outline">
																	<Plus className="mr-1 h-3 w-3" /> Assign Project
																</Button>
															</DialogTrigger>
															<DialogContent>
																<DialogHeader>
																	<DialogTitle>Assign Project</DialogTitle>
																	<DialogDescription>
																		Add a project to "{ws.name}".
																	</DialogDescription>
																</DialogHeader>
																<div className="space-y-2">
																	<Label>Project</Label>
																	<Select value={assignRemote} onValueChange={setAssignRemote}>
																		<SelectTrigger>
																			<SelectValue placeholder="Select a project" />
																		</SelectTrigger>
																		<SelectContent>
																			{projects.map((p) => (
																				<SelectItem key={p} value={p}>
																					{p}
																				</SelectItem>
																			))}
																		</SelectContent>
																	</Select>
																</div>
																<DialogFooter>
																	<DialogClose asChild>
																		<Button variant="ghost">Cancel</Button>
																	</DialogClose>
																	<DialogClose asChild>
																		<Button
																			disabled={!assignRemote || assignMutation.isPending}
																			onClick={() =>
																				assignMutation.mutate({
																					workspaceId: ws.id,
																					gitRemote: assignRemote,
																				})
																			}
																		>
																			Assign
																		</Button>
																	</DialogClose>
																</DialogFooter>
															</DialogContent>
														</Dialog>
													</div>
													{(detailQuery.data?.projects ?? []).length === 0 ? (
														<p className="text-sm text-muted-foreground">No projects assigned.</p>
													) : (
														<div className="space-y-1">
															{detailQuery.data?.projects.map((remote) => (
																<div
																	key={remote}
																	className="flex items-center justify-between rounded border bg-background px-3 py-2 text-sm"
																>
																	<span className="truncate text-muted-foreground">{remote}</span>
																	<Button
																		size="icon"
																		variant="ghost"
																		className="h-6 w-6 shrink-0"
																		disabled={removeMutation.isPending}
																		onClick={() =>
																			removeMutation.mutate({
																				workspaceId: ws.id,
																				gitRemote: remote,
																			})
																		}
																	>
																		<Trash2 className="h-3 w-3" />
																	</Button>
																</div>
															))}
														</div>
													)}
												</div>
											)}
										</TableCell>
									</TableRow>
								)}
							</>
						))}
					</TableBody>
				</Table>
			)}
		</AppLayout>
	);
}
