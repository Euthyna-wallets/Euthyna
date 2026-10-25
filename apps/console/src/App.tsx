import { QueryClientProvider } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";

import { authClient } from "./auth.js";
import { Layout } from "./components/Layout.js";
import { queryClient } from "./lib/query.js";
import { AgentsPage } from "./routes/AgentsPage.js";
import { GovernancePage } from "./routes/GovernancePage.js";
import { SharesPage } from "./routes/SharesPage.js";
import { OnboardingPage } from "./routes/OnboardingPage.js";
import { SignIn } from "./routes/SignIn.js";
import { WalletPage } from "./routes/WalletPage.js";
import { OverviewPage } from "./routes/OverviewPage.js";
import { ActivityPage } from "./routes/ActivityPage.js";
import { RolesPage } from "./routes/RolesPage.js";
import { SuppliersPage } from "./routes/SuppliersPage.js";
import { SettingsPage } from "./routes/SettingsPage.js";
import { CompanyPublicPage } from "./routes/public/CompanyPublicPage.js";
import { ExplorePage } from "./routes/public/ExplorePage.js";

function Gate() {
  const session = authClient.useSession();
  const location = useLocation();
  const organizations = useQuery({
    queryKey: ["organizations"],
    queryFn: async () => (await authClient.organization.list()).data as Array<{ id: string }> | null,
    enabled: Boolean(session.data),
  });
  if (session.isPending) return <div className="state">Loading session…</div>;
  if (!session.data) return <SignIn />;
  if (organizations.isLoading) return <div className="state">Loading organization…</div>;
  if (organizations.error) return <div className="state error">Error: {organizations.error.message}</div>;
  if (!organizations.data?.length && location.pathname !== "/onboarding") {
    return <Navigate to="/onboarding" replace />;
  }
  return <Outlet />;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          {/* Public pages: read from NEAR, no sign-in. */}
          <Route path="/" element={<ExplorePage />} />
          <Route path="/explore" element={<Navigate to="/" replace />} />
          <Route path="/c/:dao" element={<CompanyPublicPage />} />
          <Route element={<Gate />}>
            <Route element={<Layout />}>
              <Route path="/overview" element={<OverviewPage />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/roles" element={<RolesPage />} />
              <Route path="/activity" element={<ActivityPage />} />
              <Route path="/wallet" element={<WalletPage />} />
              <Route path="/mandate" element={<Navigate to="/roles" replace />} />
              <Route path="/payments" element={<Navigate to="/activity" replace />} />
              <Route path="/governance" element={<GovernancePage />} />
              <Route path="/shares" element={<SharesPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/suppliers" element={<SuppliersPage />} />
              <Route path="/onboarding" element={<OnboardingPage />} />
              <Route path="/decisions" element={<Navigate to="/governance" replace />} />
              <Route path="*" element={<Navigate to="/overview" replace />} />
            </Route>
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
