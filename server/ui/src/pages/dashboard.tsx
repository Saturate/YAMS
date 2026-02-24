import type { Memory, StatsResponse } from "@/api";
import { api } from "@/api";
import { AppLayout } from "@/components/layout";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
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
import { Brain, FolderGit2, KeyRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

export function DashboardPage() {
	const { call } = useApi();
	const [stats, setStats] = useState<StatsResponse | null>(null);
	const [recent, setRecent] = useState<Memory[]>([]);
	const [loading, setLoading] = useState(true);

	const fetchData = useCallback(async () => {
		try {
			const [s, m] = await Promise.all([
				call((t) => api.getStats(t)),
				call((t) => api.listMemories(t, { limit: 5 })),
			]);
			setStats(s);
			setRecent(m.memories);
		} catch {
			// handled by useApi
		} finally {
			setLoading(false);
		}
	}, [call]);

	useEffect(() => {
		fetchData();
	}, [fetchData]);

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
							<CardTitle className="text-sm font-medium">
								Memories
							</CardTitle>
							<Brain className="h-4 w-4 text-muted-foreground" />
						</CardHeader>
						<CardContent>
							<div className="text-2xl font-bold">
								{stats.memories}
							</div>
						</CardContent>
					</Card>
					<Card>
						<CardHeader className="flex flex-row items-center justify-between pb-2">
							<CardTitle className="text-sm font-medium">
								API Keys
							</CardTitle>
							<KeyRound className="h-4 w-4 text-muted-foreground" />
						</CardHeader>
						<CardContent>
							<div className="text-2xl font-bold">
								{stats.keys.active}
								<span className="ml-1 text-sm font-normal text-muted-foreground">
									/ {stats.keys.total}
								</span>
							</div>
							<p className="text-xs text-muted-foreground">
								active
							</p>
						</CardContent>
					</Card>
					<Card>
						<CardHeader className="flex flex-row items-center justify-between pb-2">
							<CardTitle className="text-sm font-medium">
								Projects
							</CardTitle>
							<FolderGit2 className="h-4 w-4 text-muted-foreground" />
						</CardHeader>
						<CardContent>
							<div className="text-2xl font-bold">
								{stats.projects}
							</div>
						</CardContent>
					</Card>
				</div>
			)}

			<Card>
				<CardHeader>
					<CardTitle>Recent Memories</CardTitle>
					<CardDescription>
						Last 5 memories stored across all projects.
					</CardDescription>
				</CardHeader>
				<CardContent>
					{recent.length === 0 ? (
						<p className="py-4 text-center text-sm text-muted-foreground">
							No memories yet.
						</p>
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
										<TableCell className="max-w-xs truncate font-medium">
											{m.summary}
										</TableCell>
										<TableCell className="text-sm text-muted-foreground">
											{m.git_remote ?? "—"}
										</TableCell>
										<TableCell className="text-sm">
											{m.scope}
										</TableCell>
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
