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
import { ChevronLeft, ChevronRight, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";

const PAGE_SIZE = 20;
const ALL = "__all__";

const TYPE_COLORS: Record<string, string> = {
	decision: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
	solution: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
	lesson: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
	fact: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
	convention: "bg-slate-100 text-slate-800 dark:bg-slate-900 dark:text-slate-200",
	goal: "bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-200",
};

export function MemoriesPage() {
	const queryClient = useQueryClient();
	const [page, setPage] = useState(0);
	const [selectedRemote, setSelectedRemote] = useState(ALL);
	const [selectedScope, setSelectedScope] = useState(ALL);
	const [selectedType, setSelectedType] = useState(ALL);
	const [showDeleted, setShowDeleted] = useState(false);

	const filtersQuery = useQuery({
		queryKey: ["filters"],
		queryFn: () => api.getFilters(),
	});

	const memoriesQuery = useQuery({
		queryKey: ["memories", "list", selectedRemote, selectedScope, selectedType, showDeleted, page],
		queryFn: () =>
			api.listMemories({
				git_remote: selectedRemote !== ALL ? selectedRemote : undefined,
				scope: selectedScope !== ALL ? selectedScope : undefined,
				memory_type: selectedType !== ALL ? selectedType : undefined,
				include_deleted: showDeleted || undefined,
				limit: PAGE_SIZE,
				offset: page * PAGE_SIZE,
			}),
	});

	const deleteMutation = useMutation({
		mutationFn: (id: string) => api.deleteMemory(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["memories"] });
			queryClient.invalidateQueries({ queryKey: ["stats"] });
			queryClient.invalidateQueries({ queryKey: ["filters"] });
		},
	});

	const restoreMutation = useMutation({
		mutationFn: (id: string) => api.restoreMemory(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["memories"] });
			queryClient.invalidateQueries({ queryKey: ["stats"] });
		},
	});

	function handleRemoteChange(value: string) {
		setSelectedRemote(value);
		setPage(0);
	}

	function handleScopeChange(value: string) {
		setSelectedScope(value);
		setPage(0);
	}

	function handleTypeChange(value: string) {
		setSelectedType(value);
		setPage(0);
	}

	function clearFilters() {
		setSelectedRemote(ALL);
		setSelectedScope(ALL);
		setSelectedType(ALL);
		setShowDeleted(false);
		setPage(0);
	}

	const projects = filtersQuery.data?.projects ?? [];
	const scopes = filtersQuery.data?.scopes ?? [];
	const types = filtersQuery.data?.types ?? [];
	const memories = memoriesQuery.data?.memories ?? [];
	const total = memoriesQuery.data?.total ?? 0;
	const totalPages = Math.ceil(total / PAGE_SIZE);
	const hasFilters =
		selectedRemote !== ALL || selectedScope !== ALL || selectedType !== ALL || showDeleted;

	return (
		<AppLayout>
			<h2 className="mb-6 text-2xl font-semibold">Memories</h2>

			<div className="mb-4 flex flex-wrap items-end gap-3">
				<div className="space-y-1">
					<span id="project-filter-label" className="text-xs text-muted-foreground">
						Project
					</span>
					<Select value={selectedRemote} onValueChange={handleRemoteChange}>
						<SelectTrigger className="w-64" aria-labelledby="project-filter-label">
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
					<span id="scope-filter-label" className="text-xs text-muted-foreground">
						Scope
					</span>
					<Select value={selectedScope} onValueChange={handleScopeChange}>
						<SelectTrigger className="w-40" aria-labelledby="scope-filter-label">
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
				<div className="space-y-1">
					<span id="type-filter-label" className="text-xs text-muted-foreground">
						Type
					</span>
					<Select value={selectedType} onValueChange={handleTypeChange}>
						<SelectTrigger className="w-40" aria-labelledby="type-filter-label">
							<SelectValue placeholder="All types" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>All types</SelectItem>
							{types.map((t) => (
								<SelectItem key={t} value={t}>
									{t}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<label className="flex items-center gap-1.5 text-sm text-muted-foreground">
					<input
						type="checkbox"
						checked={showDeleted}
						onChange={(e) => {
							setShowDeleted(e.target.checked);
							setPage(0);
						}}
					/>
					Show deleted
				</label>
				{hasFilters && (
					<Button size="sm" variant="ghost" onClick={clearFilters}>
						Clear
					</Button>
				)}
				<p className="ml-auto text-sm text-muted-foreground">
					{total} {total === 1 ? "memory" : "memories"}
				</p>
			</div>

			{memoriesQuery.isLoading ? (
				<p className="text-sm text-muted-foreground">Loading...</p>
			) : memories.length === 0 ? (
				<div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12">
					<p className="text-sm text-muted-foreground">
						{hasFilters ? "No memories match the current filters." : "No memories stored yet."}
					</p>
				</div>
			) : (
				<>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Title</TableHead>
								<TableHead className="w-[30%]">Summary</TableHead>
								<TableHead>Type</TableHead>
								<TableHead>Project</TableHead>
								<TableHead>Scope</TableHead>
								<TableHead>Created</TableHead>
								<TableHead className="w-[50px]" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{memories.map((m) => {
								const isDeleted = m.deleted_at != null;
								return (
									<TableRow key={m.id} className={isDeleted ? "opacity-50" : undefined}>
										<TableCell className="max-w-[200px] truncate font-medium">
											{m.title ?? "\u2014"}
											{m.path && (
												<span className="ml-1 text-xs text-muted-foreground">{m.path}</span>
											)}
										</TableCell>
										<TableCell className="max-w-[300px] truncate text-sm text-muted-foreground">
											{m.summary}
										</TableCell>
										<TableCell>
											{m.memory_type && (
												<Badge variant="secondary" className={TYPE_COLORS[m.memory_type] ?? ""}>
													{m.memory_type}
												</Badge>
											)}
										</TableCell>
										<TableCell className="max-w-[200px] truncate text-sm text-muted-foreground">
											{m.git_remote ?? "\u2014"}
										</TableCell>
										<TableCell>
											<Badge variant="secondary">{m.scope}</Badge>
										</TableCell>
										<TableCell className="text-sm text-muted-foreground">
											{relativeTime(m.created_at)}
										</TableCell>
										<TableCell>
											{isDeleted ? (
												<Button
													size="icon"
													variant="ghost"
													aria-label="Restore memory"
													disabled={restoreMutation.isPending}
													onClick={() => restoreMutation.mutate(m.id)}
												>
													<RotateCcw className="h-4 w-4" />
												</Button>
											) : (
												<Button
													size="icon"
													variant="ghost"
													aria-label="Delete memory"
													disabled={deleteMutation.isPending}
													onClick={() => deleteMutation.mutate(m.id)}
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
