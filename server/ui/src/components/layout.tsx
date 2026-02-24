import { useAuth } from "@/auth-context";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
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

const NAV_ITEMS = [
	{ to: "/dashboard", label: "Dashboard" },
	{ to: "/keys", label: "API Keys" },
	{ to: "/memories", label: "Memories" },
];

export function AppLayout({ children }: { children: ReactNode }) {
	const { logout } = useAuth();
	const { pathname } = useLocation();

	return (
		<div className="min-h-svh">
			<header className="border-b">
				<div className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-4">
					<h1 className="text-lg font-semibold">YAMS</h1>
					<nav className="flex gap-1">
						{NAV_ITEMS.map((item) => (
							<Button
								key={item.to}
								variant="ghost"
								size="sm"
								asChild
								className={cn(
									pathname === item.to && "bg-accent",
								)}
							>
								<Link to={item.to}>{item.label}</Link>
							</Button>
						))}
					</nav>
					<div className="ml-auto">
						<Button
							variant="ghost"
							size="sm"
							onClick={logout}
						>
							Log out
						</Button>
					</div>
				</div>
			</header>
			<main className="mx-auto max-w-5xl px-4 py-6">
				{children}
			</main>
		</div>
	);
}
