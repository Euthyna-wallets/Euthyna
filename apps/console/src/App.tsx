import { QueryClientProvider } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";

import { authClient } from "./auth.js";
import { Layout } from "./components/Layout.js";
import { queryClient } from "./lib/query.js";
import { AgentsPage } from "./routes/AgentsPage.js";
import { GovernancePage } from "./routes/GovernancePage.js";
import { SharesPage } from "./routes/SharesPage.js";
import { OnboardingScreen } from "./routes/OnboardingPage.js";
import { SignIn } from "./routes/SignIn.js";
import { WalletPage } from "./routes/WalletPage.js";
import { OverviewPage } from "./routes/OverviewPage.js";
import { ActivityPage } from "./routes/ActivityPage.js";
import { RolesPage } from "./routes/RolesPage.js";
import { SuppliersPage } from "./routes/SuppliersPage.js";
import { SettingsPage } from "./routes/SettingsPage.js";
import { CompanyPublicPage } from "./routes/public/CompanyPublicPage.js";
import { ExplorePage } from "./routes/public/ExplorePage.js";
import { AtlantisLanding } from "./routes/public/atlantis/AtlantisLanding.js";
import { WhitepaperPage } from "./routes/public/atlantis/WhitepaperPage.js";
import { MarketPage } from "./routes/public/MarketPage.js";
import { MarketTaskPage } from "./routes/public/MarketTaskPage.js";
import { RobPage } from "./routes/public/RobPage.js";
import { MarketConsolePage } from "./routes/MarketConsolePage.js";
import { RecoverPage } from "./routes/public/RecoverPage.js";

/** While the session loads: the night with the mark, never a blank or legacy screen. */
function Splash({ error }: { error?: string }) {
  return (
    <div className="splash" role={error ? "alert" : "status"} aria-busy={!error}>
      <svg width="44" height="44" viewBox="0 0 1024 1024" aria-hidden="true">
        <circle cx="512" cy="512" r="307" fill="none" stroke="#F3EFE6" strokeWidth="102" />
        <rect x="297" y="461" width="430" height="102" fill="#C9890C" />
        <rect x="41" y="461" width="72" height="102" fill="#C9890C" />
        <rect x="911" y="461" width="72" height="102" fill="#C9890C" />
      </svg>
      <b>EUTHYNA</b>
      <span>{error ? `Could not reach the console: ${error}` : "Opening the assembly…"}</span>
    </div>
  );
}

function Gate() {
  const session = authClient.useSession();
  const location = useLocation();
  const organizations = useQuery({
    queryKey: ["organizations"],
    queryFn: async () => (await authClient.organization.list()).data as Array<{ id: string }> | null,
    enabled: Boolean(session.data),
  });
  if (session.isPending) return <Splash />;
  if (!session.data) return <SignIn />;
  if (organizations.isLoading) return <Splash />;
  if (organizations.error) return <Splash error={organizations.error.message} />;
  // One setup path since 31 October: a member without a company goes straight to it.
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
          <Route path="/" element={<AtlantisLanding />} />
          <Route path="/whitepaper" element={<WhitepaperPage />} />
          <Route path="/explore" element={<ExplorePage />} />
          <Route path="/c/:dao" element={<CompanyPublicPage />} />
          <Route path="/market" element={<MarketPage />} />
          <Route path="/market/task/:id" element={<MarketTaskPage />} />
          <Route path="/rob" element={<RobPage />} />
          {/* Signed in, but not a member yet: the new account of a founder. */}
          <Route path="/recover" element={<RecoverPage />} />
          <Route element={<Gate />}>
            <Route path="/choose-path" element={<Navigate to="/onboarding" replace />} />
            {/* Setup is a full screen of its own (design-handoff/app 07 and 17), outside the console shell. */}
            <Route path="/onboarding" element={<OnboardingScreen />} />
            <Route element={<Layout />}>
              <Route path="/overview" element={<OverviewPage />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/roles" element={<RolesPage />} />
              <Route path="/activity" element={<ActivityPage />} />
              <Route path="/wallet" element={<WalletPage />} />
              <Route path="/selling" element={<MarketConsolePage />} />
              <Route path="/mandate" element={<Navigate to="/roles" replace />} />
              <Route path="/payments" element={<Navigate to="/activity" replace />} />
              <Route path="/governance" element={<GovernancePage />} />
              <Route path="/shares" element={<SharesPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/suppliers" element={<SuppliersPage />} />
              <Route path="/decisions" element={<Navigate to="/governance" replace />} />
              <Route path="*" element={<Navigate to="/overview" replace />} />
            </Route>
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
