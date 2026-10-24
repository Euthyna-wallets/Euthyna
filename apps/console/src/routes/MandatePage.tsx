import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { api, type MandatePreview, type TreasuryView } from "../api.js";
import { PageState } from "../components/ui.js";
import { MandatePanel } from "./OnboardingPage.js";

export function MandatePage() {
  const [preview, setPreview] = useState<MandatePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["treasury"], queryFn: () => api<{ treasury: TreasuryView | null }>("/v1/console/treasury") });
  return (
    <div className="page">
      <header className="page-head"><div><h1>Spending permission</h1><p className="muted"><Link to="/agents">← Agents</Link></p></div></header>
      <PageState loading={query.isLoading} error={query.error} empty={!query.data?.treasury} emptyContent={<div className="state empty-action">Create the Treasury first. <Link className="button primary" to="/onboarding">Finish setup</Link></div>}>
        {query.data?.treasury ? (
          <>{error ? <div className="state error">{error}</div> : null}<MandatePanel treasury={query.data.treasury} preview={preview} onPreview={setPreview} onError={setError} /></>
        ) : null}
      </PageState>
    </div>
  );
}
