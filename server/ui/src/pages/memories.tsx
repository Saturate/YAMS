import type { Memory } from "@/api";
import { api } from "@/api";
import { AppLayout } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { useApi } from "@/hooks/use-api";
import { relativeTime } from "@/lib/utils";
import { ChevronLeft, ChevronRight, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

const PAGE_SIZE = 20;

export function MemoriesPage() {
	const { call } = useApi();
	const [memories, setMemories] = useState<Memory[]>([]);
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(true);
	const [page, setPage] = useState(0);

	const [filterRemote, setFilterRemote] = useState("");
	const [filterScope, setFilterScope] = useState("");
	const [appliedRemote, setAppliedRemote] = useState("");
	const [appliedScope, setAppliedScope] = useState("");

	const fetchMemories = useCallback(async () => {
		setLoading(true);
		try {
			const data = await call((t) =>
				api.listMemories(t, {
					git_remote: appliedRemote || undefined,
					scope: appliedScope || undefined,
					limit: PAGE_SIZE,
					offset: page * PAGE_SIZE,
				}),
			);
			setMemories(data.memories);
			setTotal(data.total);
		} catch {
			// handled by useApi
		} finally {
			setLoading(false);
		}
	}, [call, appliedRemote, appliedScope, page]);

	useEffect(() => {
		fetchMemories();
	}, [fetchMemories]);

	function applyFilters() {
		setAppliedRemote(filterRemote.trim());
		setAppliedScope(filterScope.trim());
		setPage(0);
	}

	function clearFilters() {
		setFilterRemote("");
		setFilterScope("");
		setAppliedRemote("");
		setAppliedScope("");
		setPage(0);
	}

	async function handleDelete(id: string) {
		try {
			await call((t) => api.deleteMemory(t, id));
			fetchMemories();
		} catch {
			// handled by useApi
		}
	}

	const totalPages = Math.ceil(total / PAGE_SIZE);
	const hasFilters = appliedRemote || appliedScope;

	return (
		<AppLayout>
			<h2 className="mb-6 text-2xl font-semibold">Memories</h2>

			<div className="mb-4 flex flex-wrap items-end gap-3">
				<div className="space-y-1">
					<label
						htmlFor="filter-remote"
						className="text-xs text-muted-foreground"
					>
						Project (git remote)
					</label>
					<Input
						id="filter-remote"
						placeholder="e.g. github.com/org/repo"
						value={filterRemote}
						onChange={(e) => setFilterRemote(e.target.value)}
						className="w-64"
					/>
				</div>
				<div className="space-y-1">
					<label
						htmlFor="filter-scope"
						className="text-xs text-muted-foreground"
					>
						Scope
					</label>
					<Input
						id="filter-scope"
						placeholder="session, project, global"
						value={filterScope}
						onChange={(e) => setFilterScope(e.target.value)}
						className="w-40"
					/>
				</div>
				<Button size="sm" onClick={applyFilters}>
					<Search className="mr-1 h-4 w-4" />
					Filter
				</Button>
				{hasFilters && (
					<Button
						size="sm"
						variant="ghost"
						onClick={clearFilters}
					>
						Clear
					</Button>
				)}
				<p className="ml-auto text-sm text-muted-foreground">
					{total} {total === 1 ? "memory" : "memories"}
				</p>
			</div>

			{loading ? (
				<p className="text-sm text-muted-foreground">Loading...</p>
			) : memories.length === 0 ? (
				<div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12">
					<p className="text-sm text-muted-foreground">
						{hasFilters
							? "No memories match the current filters."
							: "No memories stored yet."}
					</p>
				</div>
			) : (
				<>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="w-[40%]">
									Summary
								</TableHead>
								<TableHead>Project</TableHead>
								<TableHead>Scope</TableHead>
								<TableHead>Created</TableHead>
								<TableHead className="w-[50px]" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{memories.map((m) => (
								<TableRow key={m.id}>
									<TableCell className="font-medium">
										{m.summary}
									</TableCell>
									<TableCell className="max-w-[200px] truncate text-sm text-muted-foreground">
										{m.git_remote ?? "—"}
									</TableCell>
									<TableCell>
										<Badge variant="secondary">
											{m.scope}
										</Badge>
									</TableCell>
									<TableCell className="text-sm text-muted-foreground">
										{relativeTime(m.created_at)}
									</TableCell>
									<TableCell>
										<Button
											size="icon"
											variant="ghost"
											onClick={() =>
												handleDelete(m.id)
											}
										>
											<Trash2 className="h-4 w-4" />
										</Button>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>

					{totalPages > 1 && (
						<div className="mt-4 flex items-center justify-center gap-2">
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
