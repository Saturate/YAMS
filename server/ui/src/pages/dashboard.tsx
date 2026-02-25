import type { SearchResult } from "@/api";
import { api } from "@/api";
import { AppLayout } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { relativeTime } from "@/lib/utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Brain, FolderGit2, KeyRound, Search } from "lucide-react";
import { type FormEvent, useState } from "react";

export function DashboardPage() {
	const [query, setQuery] = useState("");
	const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);

	const statsQuery = useQuery({
		queryKey: ["stats"],
		queryFn: () => api.getStats(),
	});

	const recentQuery = useQuery({
		queryKey: ["memories", "recent"],
		queryFn: () => api.listMemories({ limit: 5 }),
	});

	const searchMutation = useMutation({
		mutationFn: (q: string) => api.searchMemories(q, { limit: 10 }),
		onSuccess: (data) => setSearchResults(data.results),
	});

	function handleSearch(e: FormEvent) {
		e.preventDefault();
		const q = query.trim();
		if (!q) return;
		searchMutation.mutate(q);
	}

	function clearSearch() {
		setQuery("");
		setSearchResults(null);
		searchMutation.reset();
	}

	const stats = statsQuery.data;
	const recent = recentQuery.data?.memories ?? [];
	const loading = statsQuery.isLoading || recentQuery.isLoading;

	if (loading) {
		return (
			<AppLayout>
				<p className="text-sm text-muted-foreground">Loading...</p>
			</AppLayout>
		);
	}

	return (
		<AppLayout>
			<h2 className="mb-6 text-2xl font-semibold">Dashboard</h2>

			{stats && (
				<div className="mb-8 grid gap-4 sm:grid-cols-3">
					<Card>
						<CardHeader className="flex flex-row items-center justify-between pb-2">
							<CardTitle className="text-sm font-medium">Memories</CardTitle>
							<Brain className="h-4 w-4 text-muted-foreground" />
						</CardHeader>
						<CardContent>
							<div className="text-2xl font-bold">{stats.memories}</div>
						</CardContent>
					</Card>
					<Card>
						<CardHeader className="flex flex-row items-center justify-between pb-2">
							<CardTitle className="text-sm font-medium">API Keys</CardTitle>
							<KeyRound className="h-4 w-4 text-muted-foreground" />
						</CardHeader>
						<CardContent>
							<div className="text-2xl font-bold">
								{stats.keys.active}
								<span className="ml-1 text-sm font-normal text-muted-foreground">
									/ {stats.keys.total}
								</span>
							</div>
							<p className="text-xs text-muted-foreground">active</p>
						</CardContent>
					</Card>
					<Card>
						<CardHeader className="flex flex-row items-center justify-between pb-2">
							<CardTitle className="text-sm font-medium">Projects</CardTitle>
							<FolderGit2 className="h-4 w-4 text-muted-foreground" />
						</CardHeader>
						<CardContent>
							<div className="text-2xl font-bold">{stats.projects}</div>
						</CardContent>
					</Card>
				</div>
			)}

			<Card className="mb-8">
				<CardHeader>
					<CardTitle>Search Memories</CardTitle>
					<CardDescription>Semantic search across all stored memories.</CardDescription>
				</CardHeader>
				<CardContent>
					<form onSubmit={handleSearch} className="flex items-center gap-2">
						<Input
							aria-label="Search memories"
							placeholder="What do you remember about..."
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							className="flex-1"
						/>
						<Button type="submit" size="sm" disabled={searchMutation.isPending || !query.trim()}>
							<Search className="mr-1 h-4 w-4" />
							{searchMutation.isPending ? "Searching..." : "Search"}
						</Button>
						{searchResults !== null && (
							<Button type="button" size="sm" variant="ghost" onClick={clearSearch}>
								Clear
							</Button>
						)}
					</form>

					{searchMutation.isError && (
						<p className="mt-3 text-sm text-destructive">{searchMutation.error.message}</p>
					)}

					{searchResults !== null && (
						<div className="mt-4">
							{searchResults.length === 0 ? (
								<p className="py-4 text-center text-sm text-muted-foreground">
									No matching memories found.
								</p>
							) : (
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead className="w-16">Score</TableHead>
											<TableHead>Summary</TableHead>
											<TableHead>Project</TableHead>
											<TableHead>Scope</TableHead>
											<TableHead>Created</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{searchResults.map((r) => (
											<TableRow key={r.id}>
												<TableCell>
													<Badge variant={r.score > 0.7 ? "default" : "secondary"}>
														{(r.score * 100).toFixed(0)}%
													</Badge>
												</TableCell>
												<TableCell className="font-medium">{r.summary}</TableCell>
												<TableCell className="text-sm text-muted-foreground">
													{r.git_remote ?? "\u2014"}
												</TableCell>
												<TableCell className="text-sm">{r.scope}</TableCell>
												<TableCell className="text-sm text-muted-foreground">
													{relativeTime(r.created_at)}
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							)}
						</div>
					)}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Recent Memories</CardTitle>
					<CardDescription>Last 5 memories stored across all projects.</CardDescription>
				</CardHeader>
				<CardContent>
					{recent.length === 0 ? (
						<p className="py-4 text-center text-sm text-muted-foreground">No memories yet.</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Summary</TableHead>
									<TableHead>Project</TableHead>
									<TableHead>Scope</TableHead>
									<TableHead>Created</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{recent.map((m) => (
									<TableRow key={m.id}>
										<TableCell className="max-w-xs truncate font-medium">{m.summary}</TableCell>
										<TableCell className="text-sm text-muted-foreground">
											{m.git_remote ?? "\u2014"}
										</TableCell>
										<TableCell className="text-sm">{m.scope}</TableCell>
										<TableCell className="text-sm text-muted-foreground">
											{relativeTime(m.created_at)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>
		</AppLayout>
	);
}
