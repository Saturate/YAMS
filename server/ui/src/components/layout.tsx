import { useAuth } from "@/auth-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { randomBackronym } from "@/husk";
import { cn } from "@/lib/utils";
import { type ReactNode, useMemo } from "react";
import { Link, useLocation } from "react-router";

export function AuthLayout({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
	children: ReactNode;
}) {
	return (
		<div className="flex min-h-svh items-center justify-center p-4">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle className="text-xl">{title}</CardTitle>
					<CardDescription>{description}</CardDescription>
				</CardHeader>
				<CardContent>{children}</CardContent>
			</Card>
		</div>
	);
}

interface NavItem {
	to: string;
	label: string;
	adminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
	{ to: "/dashboard", label: "Dashboard" },
	{ to: "/keys", label: "API Keys" },
	{ to: "/memories", label: "Memories" },
	{ to: "/sessions", label: "Sessions" },
	{ to: "/graph", label: "Graph" },
	{ to: "/timeline", label: "Timeline" },
	{ to: "/workspaces", label: "Workspaces" },
	{ to: "/users", label: "Users", adminOnly: true },
	{ to: "/settings", label: "Settings" },
];

export function AppLayout({ children }: { children: ReactNode }) {
	const { logout, isAdmin, username } = useAuth();
	const { pathname } = useLocation();
	const acronym = useMemo(() => randomBackronym(), []);

	return (
		<div className="min-h-svh">
			<a
				href="#main-content"
				className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded focus:bg-background focus:px-4 focus:py-2 focus:text-foreground focus:shadow-lg"
			>
				Skip to content
			</a>
			<header className="border-b">
				<div className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-4">
					<h1 className="text-lg font-semibold" title={acronym}>
						HUSK
					</h1>
					<nav aria-label="Main navigation" className="flex gap-1">
						{NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin).map((item) => (
							<Button
								key={item.to}
								variant="ghost"
								size="sm"
								asChild
								className={cn(pathname === item.to && "bg-accent")}
							>
								<Link to={item.to}>{item.label}</Link>
							</Button>
						))}
					</nav>
					<div className="ml-auto flex items-center gap-2">
						{username && <span className="text-sm text-muted-foreground">{username}</span>}
						<Button variant="ghost" size="sm" onClick={logout}>
							Log out
						</Button>
					</div>
				</div>
			</header>
			<main id="main-content" className="mx-auto max-w-5xl px-4 py-6">
				{children}
			</main>
		</div>
	);
}
