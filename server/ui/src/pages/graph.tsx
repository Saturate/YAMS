import { type GraphNode, api } from "@/api";
import { AppLayout } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { resolvedScopeColor } from "@/lib/scope-colors";
import { relativeTime } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";

const ALL = "__all__";

export function GraphPage() {
	const [selectedProject, setSelectedProject] = useState(ALL);
	const [selectedScope, setSelectedScope] = useState(ALL);
	const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	const filtersQuery = useQuery({
		queryKey: ["filters"],
		queryFn: () => api.getFilters(),
	});

	const graphQuery = useQuery({
		queryKey: ["graph", selectedProject, selectedScope],
		queryFn: () =>
			api.getGraph({
				project: selectedProject !== ALL ? selectedProject : undefined,
				scope: selectedScope !== ALL ? selectedScope : undefined,
			}),
	});

	const graphData = useMemo(() => {
		if (!graphQuery.data) return { nodes: [], links: [] };
		return {
			nodes: graphQuery.data.nodes,
			links: graphQuery.data.edges.map((e) => ({
				...e,
				source: e.source,
				target: e.target,
			})),
		};
	}, [graphQuery.data]);

	const nodeCanvasObject = useCallback(
		(node: { x?: number; y?: number; scope?: string }, ctx: CanvasRenderingContext2D) => {
			const x = node.x ?? 0;
			const y = node.y ?? 0;
			const radius = 6;
			const color = resolvedScopeColor((node as GraphNode).scope ?? "");

			ctx.beginPath();
			ctx.arc(x, y, radius, 0, 2 * Math.PI);
			ctx.fillStyle = color;
			ctx.fill();
			ctx.strokeStyle = resolvedScopeColor("__border__");
			ctx.lineWidth = 1.5;
			ctx.stroke();
		},
		[],
	);

	const bgColor = useMemo(
		() => getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
		[],
	);

	const mutedFg = useMemo(
		() =>
			getComputedStyle(document.documentElement).getPropertyValue("--muted-foreground").trim() ||
			"#888",
		[],
	);

	const projects = filtersQuery.data?.projects ?? [];
	const scopes = filtersQuery.data?.scopes ?? [];
	const hasData = graphData.nodes.length > 0;

	return (
		<AppLayout>
			<div className="-mx-4 -mt-6 relative" style={{ height: "calc(100vh - 3.5rem)" }}>
				{/* Filter bar */}
				<div className="absolute top-4 left-4 z-10 flex gap-2 rounded-lg bg-background/80 p-2 backdrop-blur-sm">
					<Select value={selectedProject} onValueChange={setSelectedProject}>
						<SelectTrigger className="w-48">
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
					<Select value={selectedScope} onValueChange={setSelectedScope}>
						<SelectTrigger className="w-36">
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

				{/* Detail panel */}
				{selectedNode && (
					<Card className="absolute top-4 right-4 z-10 w-80">
						<CardHeader className="pb-2">
							<CardTitle className="text-sm font-medium">Memory Detail</CardTitle>
						</CardHeader>
						<CardContent className="space-y-2 text-sm">
							<p>{selectedNode.summary}</p>
							<div className="flex items-center gap-2">
								<Badge variant="secondary">{selectedNode.scope}</Badge>
								{selectedNode.project && (
									<span className="truncate text-muted-foreground">{selectedNode.project}</span>
								)}
							</div>
							<p className="text-xs text-muted-foreground">
								{relativeTime(selectedNode.created_at)}
							</p>
						</CardContent>
					</Card>
				)}

				{/* Graph or empty state */}
				{graphQuery.isLoading ? (
					<div className="flex h-full items-center justify-center">
						<p className="text-sm text-muted-foreground">Loading graph...</p>
					</div>
				) : !hasData ? (
					<div className="flex h-full items-center justify-center">
						<div className="rounded-lg border border-dashed px-8 py-12 text-center">
							<p className="text-sm text-muted-foreground">
								No graph data. Create relationships between memories using the link tool.
							</p>
						</div>
					</div>
				) : (
					<div ref={containerRef} className="h-full w-full">
						<ForceGraph2D
							graphData={graphData}
							nodeCanvasObject={nodeCanvasObject}
							nodeLabel={(node: object) => (node as GraphNode).summary}
							linkLabel={(link: object) => (link as { edge_type: string }).edge_type}
							linkDirectionalArrowLength={6}
							linkColor={() => mutedFg}
							backgroundColor={bgColor ? `hsl(${bgColor})` : "transparent"}
							onNodeClick={(node: object) => setSelectedNode(node as GraphNode)}
							width={containerRef.current?.clientWidth}
							height={containerRef.current?.clientHeight}
						/>
					</div>
				)}
			</div>
		</AppLayout>
	);
}
