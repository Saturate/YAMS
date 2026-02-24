import { AuthProvider } from "@/auth-context";
import { ProtectedRoute } from "@/components/protected-route";
import { DashboardPage } from "@/pages/dashboard";
import { KeysPage } from "@/pages/keys";
import { LoginPage } from "@/pages/login";
import { MemoriesPage } from "@/pages/memories";
import { SetupPage } from "@/pages/setup";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";

export function App() {
	return (
		<BrowserRouter>
			<AuthProvider>
				<Routes>
					<Route path="/setup" element={<SetupPage />} />
					<Route path="/login" element={<LoginPage />} />
					<Route element={<ProtectedRoute />}>
						<Route
							path="/dashboard"
							element={<DashboardPage />}
						/>
						<Route path="/keys" element={<KeysPage />} />
						<Route
							path="/memories"
							element={<MemoriesPage />}
						/>
					</Route>
					<Route
						path="*"
						element={<Navigate to="/dashboard" replace />}
					/>
				</Routes>
			</AuthProvider>
		</BrowserRouter>
	);
}
