import { api } from "@/api";
import { AppLayout } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Trash2 } from "lucide-react";
import { useState } from "react";

const PAGE_SIZE = 20;
const ALL = "__all__";

export function SessionsPage() {
	const queryClient = useQueryClient();
	const [page, setPage] = useState(0);
	const [statusFilter, setStatusFilter] = useState(ALL);
	const [expandedId, setExpandedId] = useState<string | null>(null);

	const sessionsQuery = useQuery({
		queryKey: ["sessions", "list", statusFilter, page],
		queryFn: () =>
			api.listSessions({
				status: statusFilter !== ALL ? statusFilter : undefined,
				limit: PAGE_SIZE,
				offset: page * PAGE_SIZE,
			}),
	});

	const detailQuery = useQuery({
		queryKey: ["sessions", "detail", expandedId],
		queryFn: () => {
			if (!expandedId) throw new Error("unreachable");
			return api.getSession(expandedId);
		},
		enabled: expandedId !== null,
	});

	const deleteMutation = useMutation({
		mutationFn: (id: string) => api.deleteSession(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["sessions"] });
			queryClient.invalidateQueries({ queryKey: ["stats"] });
			setExpandedId(null);
		},
	});

	function handleStatusChange(value: string) {
		setStatusFilter(value);
		setPage(0);
	}

	const sessions = sessionsQuery.data?.sessions ?? [];
	const total = sessionsQuery.data?.total ?? 0;
	const totalPages = Math.ceil(total / PAGE_SIZE);

	return (
		<AppLayout>
			<h2 className="mb-6 text-2xl font-semibold">Sessions</h2>

			<div className="mb-4 flex flex-wrap items-end gap-3">
				<div className="space-y-1">
					<span id="status-filter-label" className="text-xs text-muted-foreground">
						Status
					</span>
					<Select value={statusFilter} onValueChange={handleStatusChange}>
						<SelectTrigger className="w-40" aria-labelledby="status-filter-label">
							<SelectValue placeholder="All" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>All</SelectItem>
							<SelectItem value="active">Active</SelectItem>
							<SelectItem value="ended">Ended</SelectItem>
						</SelectContent>
					</Select>
				</div>
				<p className="ml-auto text-sm text-muted-foreground">
					{total} {total === 1 ? "session" : "sessions"}
				</p>
			</div>

			{sessionsQuery.isLoading ? (
				<p className="text-sm text-muted-foreground">Loading...</p>
			) : sessions.length === 0 ? (
				<div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12">
					<p className="text-sm text-muted-foreground">No sessions captured yet.</p>
				</div>
			) : (
				<>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="w-[30px]" />
								<TableHead>Project</TableHead>
								<TableHead>Status</TableHead>
								<TableHead>Observations</TableHead>
								<TableHead>Summary</TableHead>
								<TableHead>Started</TableHead>
								<TableHead className="w-[50px]" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{sessions.map((s) => (
								<>
									<TableRow key={s.id}>
										<TableCell>
											<Button
												size="icon"
												variant="ghost"
												className="h-6 w-6"
												aria-label={expandedId === s.id ? "Collapse" : "Expand"}
												onClick={() => setExpandedId(expandedId === s.id ? null : s.id)}
											>
												{expandedId === s.id ? (
													<ChevronUp className="h-4 w-4" />
												) : (
													<ChevronDown className="h-4 w-4" />
												)}
											</Button>
										</TableCell>
										<TableCell className="max-w-[200px] truncate text-sm">
											{s.project ?? "\u2014"}
										</TableCell>
										<TableCell>
											<Badge variant={s.status === "active" ? "default" : "secondary"}>
												{s.status}
											</Badge>
										</TableCell>
										<TableCell className="text-sm text-muted-foreground">
											{s.observation_count}
										</TableCell>
										<TableCell className="max-w-[300px] truncate text-sm text-muted-foreground">
											{s.summary ?? "\u2014"}
										</TableCell>
										<TableCell className="text-sm text-muted-foreground">
											{relativeTime(s.started_at)}
										</TableCell>
										<TableCell>
											<Button
												size="icon"
												variant="ghost"
												aria-label="Delete session"
												disabled={deleteMutation.isPending}
												onClick={() => deleteMutation.mutate(s.id)}
											>
												<Trash2 className="h-4 w-4" />
											</Button>
										</TableCell>
									</TableRow>
									{expandedId === s.id && (
										<TableRow key={`${s.id}-detail`}>
											<TableCell colSpan={7} className="bg-muted/50 p-4">
												{detailQuery.isLoading ? (
													<p className="text-sm text-muted-foreground">Loading observations...</p>
												) : detailQuery.data?.observations.length === 0 ? (
													<p className="text-sm text-muted-foreground">No observations.</p>
												) : (
													<div className="space-y-2">
														<p className="text-xs font-medium uppercase text-muted-foreground">
															Observations
														</p>
														<div className="max-h-80 space-y-1 overflow-y-auto">
															{detailQuery.data?.observations.map((o) => (
																<div
																	key={o.id}
																	className="flex items-start gap-2 rounded border bg-background px-3 py-2 text-sm"
																>
																	<Badge variant="outline" className="shrink-0 text-xs">
																		{o.event}
																	</Badge>
																	{o.tool_name && (
																		<Badge variant="secondary" className="shrink-0 text-xs">
																			{o.tool_name}
																		</Badge>
																	)}
																	<span className="truncate text-muted-foreground">
																		{o.content.slice(0, 200)}
																	</span>
																	<span className="ml-auto shrink-0 text-xs text-muted-foreground">
																		{relativeTime(o.created_at)}
																	</span>
																</div>
															))}
														</div>
													</div>
												)}
											</TableCell>
										</TableRow>
									)}
								</>
							))}
						</TableBody>
					</Table>

					{totalPages > 1 && (
						<div className="mt-4 flex items-center justify-center gap-2">
							<Button
								size="sm"
								variant="outline"
								aria-label="Previous page"
								disabled={page === 0}
								onClick={() => setPage((p) => p - 1)}
							>
								<ChevronLeft className="h-4 w-4" />
							</Button>
							<span className="text-sm text-muted-foreground">
								Page {page + 1} of {totalPages}
							</span>
							<Button
								size="sm"
								variant="outline"
								aria-label="Next page"
								disabled={page >= totalPages - 1}
								onClick={() => setPage((p) => p + 1)}
							>
								<ChevronRight className="h-4 w-4" />
							</Button>
						</div>
					)}
				</>
			)}
		</AppLayout>
	);
}
