import { type Memory, type Session, api } from "@/api";
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
import { scopeColor } from "@/lib/scope-colors";
import { relativeTime } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";

const PAGE_SIZE = 50;
const ALL = "__all__";

type TimelineItem =
	| { kind: "memory"; data: Memory; timestamp: string }
	| { kind: "session"; data: Session; timestamp: string };

function formatDateHeader(dateStr: string): string {
	const date = new Date(dateStr);
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(today.getTime() - 86400000);
	const itemDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

	if (itemDate.getTime() === today.getTime()) return "Today";
	if (itemDate.getTime() === yesterday.getTime()) return "Yesterday";
	return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function dateKey(dateStr: string): string {
	return new Date(dateStr).toDateString();
}

function sessionDuration(session: Session): string | null {
	if (!session.ended_at) return null;
	const ms = new Date(session.ended_at).getTime() - new Date(session.started_at).getTime();
	const mins = Math.round(ms / 60000);
	if (mins < 1) return "<1m";
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	return `${hours}h ${mins % 60}m`;
}

export function TimelinePage() {
	const [page, setPage] = useState(0);
	const [selectedProject, setSelectedProject] = useState(ALL);
	const [selectedScope, setSelectedScope] = useState(ALL);
	const [expandedId, setExpandedId] = useState<string | null>(null);

	const filtersQuery = useQuery({
		queryKey: ["filters"],
		queryFn: () => api.getFilters(),
	});

	const memoriesQuery = useQuery({
		queryKey: ["timeline-memories", selectedProject, selectedScope, page],
		queryFn: () =>
			api.listMemories({
				git_remote: selectedProject !== ALL ? selectedProject : undefined,
				scope: selectedScope !== ALL ? selectedScope : undefined,
				limit: PAGE_SIZE,
				offset: page * PAGE_SIZE,
			}),
	});

	const sessionsQuery = useQuery({
		queryKey: ["timeline-sessions", selectedProject],
		queryFn: () =>
			api.listSessions({
				project: selectedProject !== ALL ? selectedProject : undefined,
				limit: 100,
			}),
	});

	function handleProjectChange(value: string) {
		setSelectedProject(value);
		setPage(0);
	}

	function handleScopeChange(value: string) {
		setSelectedScope(value);
		setPage(0);
	}

	const projects = filtersQuery.data?.projects ?? [];
	const scopes = filtersQuery.data?.scopes ?? [];

	const items: TimelineItem[] = [];
	for (const m of memoriesQuery.data?.memories ?? []) {
		items.push({ kind: "memory", data: m, timestamp: m.created_at });
	}
	for (const s of sessionsQuery.data?.sessions ?? []) {
		items.push({ kind: "session", data: s, timestamp: s.started_at });
	}
	items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

	const totalMemories = memoriesQuery.data?.total ?? 0;
	const totalPages = Math.ceil(totalMemories / PAGE_SIZE);
	const isLoading = memoriesQuery.isLoading || sessionsQuery.isLoading;

	let lastDateKey = "";

	return (
		<AppLayout>
			<h2 className="mb-6 text-2xl font-semibold">Timeline</h2>

			<div className="mb-4 flex flex-wrap items-end gap-3">
				<div className="space-y-1">
					<span className="text-xs text-muted-foreground">Project</span>
					<Select value={selectedProject} onValueChange={handleProjectChange}>
						<SelectTrigger className="w-64">
							<SelectValue placeholder="All projects" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>All projects</SelectItem>
							{projects.map((p) => (
								<SelectItem key={p} value={p}>
									{p}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="space-y-1">
					<span className="text-xs text-muted-foreground">Scope</span>
					<Select value={selectedScope} onValueChange={handleScopeChange}>
						<SelectTrigger className="w-40">
							<SelectValue placeholder="All scopes" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>All scopes</SelectItem>
							{scopes.map((s) => (
								<SelectItem key={s} value={s}>
									{s}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>

			{isLoading ? (
				<p className="text-sm text-muted-foreground">Loading...</p>
			) : items.length === 0 ? (
				<div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12">
					<p className="text-sm text-muted-foreground">No activity yet.</p>
				</div>
			) : (
				<>
					<div className="relative ml-4 border-l-2 border-border pl-6">
						{items.map((item) => {
							const currentDateKey = dateKey(item.timestamp);
							const showHeader = currentDateKey !== lastDateKey;
							lastDateKey = currentDateKey;
							const id = item.kind === "memory" ? item.data.id : item.data.id;
							const isExpanded = expandedId === id;

							return (
								<div key={`${item.kind}-${id}`}>
									{showHeader && (
										<div className="relative -ml-6 mb-3 mt-6 first:mt-0">
											<div className="absolute -left-[9px] top-1 h-4 w-4 rounded-full border-2 border-background bg-muted-foreground" />
											<p className="ml-4 text-sm font-medium text-muted-foreground">
												{formatDateHeader(item.timestamp)}
											</p>
										</div>
									)}
									<div className="relative mb-4">
										<div
											className="absolute -left-[33px] top-2 h-3 w-3 rounded-full"
											style={{
												backgroundColor: scopeColor(
													item.kind === "memory" ? item.data.scope : "session",
												),
											}}
										/>
										<button
											type="button"
											className="w-full cursor-pointer rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent/50"
											onClick={() => setExpandedId(isExpanded ? null : id)}
										>
											{item.kind === "memory" ? (
												<MemoryItem memory={item.data} expanded={isExpanded} />
											) : (
												<SessionItem session={item.data} expanded={isExpanded} />
											)}
										</button>
									</div>
								</div>
							);
						})}
					</div>

					{totalPages > 1 && (
						<div className="mt-6 flex items-center justify-center gap-2">
							<Button
								size="sm"
								variant="outline"
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

function MemoryItem({ memory, expanded }: { memory: Memory; expanded: boolean }) {
	return (
		<div className="space-y-1">
			<div className="flex items-center gap-2">
				<Badge variant="outline" className="text-xs">
					memory
				</Badge>
				<Badge variant="secondary" className="text-xs">
					{memory.scope}
				</Badge>
				{memory.git_remote && (
					<span className="truncate text-xs text-muted-foreground">{memory.git_remote}</span>
				)}
				<span className="ml-auto shrink-0 text-xs text-muted-foreground">
					{relativeTime(memory.created_at)}
				</span>
			</div>
			<p className={expanded ? "text-sm" : "truncate text-sm"}>{memory.summary}</p>
			{expanded && memory.metadata && (
				<pre className="mt-2 overflow-auto rounded bg-muted p-2 text-xs">{memory.metadata}</pre>
			)}
		</div>
	);
}

function SessionItem({ session, expanded }: { session: Session; expanded: boolean }) {
	const duration = sessionDuration(session);
	return (
		<div className="space-y-1">
			<div className="flex items-center gap-2">
				<Badge variant="outline" className="text-xs">
					session
				</Badge>
				<Badge variant={session.status === "active" ? "default" : "secondary"} className="text-xs">
					{session.status}
				</Badge>
				<span className="text-xs text-muted-foreground">
					{session.observation_count} observations
				</span>
				{duration && <span className="text-xs text-muted-foreground">({duration})</span>}
				{session.project && (
					<span className="truncate text-xs text-muted-foreground">{session.project}</span>
				)}
				<span className="ml-auto shrink-0 text-xs text-muted-foreground">
					{relativeTime(session.started_at)}
				</span>
			</div>
			{session.summary && (
				<p className={expanded ? "text-sm" : "truncate text-sm"}>{session.summary}</p>
			)}
		</div>
	);
}
