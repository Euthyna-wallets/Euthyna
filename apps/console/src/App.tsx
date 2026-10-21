import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Outlet, Route, Routes } from "react-router-dom";

import { authClient } from "./auth.js";
import { Layout } from "./components/Layout.js";
import { queryClient } from "./lib/query.js";
import { AgentDetailPage } from "./routes/AgentDetailPage.js";
import { AgentsPage } from "./routes/AgentsPage.js";
import { EscalationsPage } from "./routes/EscalationsPage.js";
import { GovernancePage } from "./routes/GovernancePage.js";
import { MandatePage } from "./routes/MandatePage.js";
import { OnboardingPage, SignIn } from "./routes/OnboardingPage.js";
import { OverviewPage } from "./routes/OverviewPage.js";
import { PaymentDetailPage } from "./routes/PaymentDetailPage.js";
import { PaymentsPage } from "./routes/PaymentsPage.js";
import { SuppliersPage } from "./routes/SuppliersPage.js";

function Gate() {
  const session = authClient.useSession();
  if (session.isPending) return <div className="state">Loading session…</div>;
  if (!session.data) return <SignIn />;
  return <Outlet />;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route element={<Gate />}>
            <Route element={<Layout />}>
              <Route path="/" element={<OverviewPage />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/agents/:id" element={<AgentDetailPage />} />
              <Route path="/payments" element={<PaymentsPage />} />
              <Route path="/payments/:opId" element={<PaymentDetailPage />} />
              <Route path="/escalations" element={<EscalationsPage />} />
              <Route path="/suppliers" element={<SuppliersPage />} />
              <Route path="/governance" element={<GovernancePage />} />
              <Route path="/mandate" element={<MandatePage />} />
            </Route>
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
