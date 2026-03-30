import { AuthError, SetupRequiredError } from "@/api";
import { AuthProvider } from "@/auth-context";
import { ProtectedRoute } from "@/components/protected-route";
import { DashboardPage } from "@/pages/dashboard";
import { GraphPage } from "@/pages/graph";
import { InvitePage } from "@/pages/invite";
import { KeysPage } from "@/pages/keys";
import { LoginPage } from "@/pages/login";
import { MemoriesPage } from "@/pages/memories";
import { SessionsPage } from "@/pages/sessions";
import { SettingsPage } from "@/pages/settings";
import { SetupPage } from "@/pages/setup";
import { TimelinePage } from "@/pages/timeline";
import { UsersPage } from "@/pages/users";
import { WorkspacesPage } from "@/pages/workspaces";
import { ThemeProvider } from "@/theme-context";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";

function handleGlobalError(error: Error) {
	if (error instanceof AuthError) {
		window.location.href = "/login";
	} else if (error instanceof SetupRequiredError) {
		window.location.href = "/setup";
	}
}

const queryClient = new QueryClient({
	queryCache: new QueryCache({ onError: handleGlobalError }),
	mutationCache: new MutationCache({ onError: handleGlobalError }),
	defaultOptions: {
		queries: {
			retry: false,
			staleTime: 30_000,
			refetchInterval: 60_000,
		},
	},
});

export function App() {
	return (
		<QueryClientProvider client={queryClient}>
			<ThemeProvider>
				<BrowserRouter>
					<AuthProvider>
						<Routes>
							<Route path="/setup" element={<SetupPage />} />
							<Route path="/login" element={<LoginPage />} />
							<Route path="/invite/:token" element={<InvitePage />} />
							<Route element={<ProtectedRoute />}>
								<Route path="/dashboard" element={<DashboardPage />} />
								<Route path="/keys" element={<KeysPage />} />
								<Route path="/memories" element={<MemoriesPage />} />
								<Route path="/sessions" element={<SessionsPage />} />
								<Route path="/graph" element={<GraphPage />} />
								<Route path="/timeline" element={<TimelinePage />} />
								<Route path="/workspaces" element={<WorkspacesPage />} />
								<Route path="/users" element={<UsersPage />} />
								<Route path="/settings" element={<SettingsPage />} />
							</Route>
							<Route path="*" element={<Navigate to="/dashboard" replace />} />
						</Routes>
					</AuthProvider>
				</BrowserRouter>
			</ThemeProvider>
		</QueryClientProvider>
	);
}
