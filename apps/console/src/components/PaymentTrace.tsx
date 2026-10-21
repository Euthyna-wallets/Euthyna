export interface TraceStep {
  step: string;
  at: string | Date | null;
  txHash: string | null;
}

export function PaymentTrace({ steps }: { steps: TraceStep[] }) {
  return (
    <ol className="trace" aria-label="Payment trace">
      {steps.map((step) => (
        <li key={step.step} className={step.at ? "trace-step done" : "trace-step"}>
          <div className="trace-dot" aria-hidden="true" />
          <div className="trace-body">
            <strong>{step.step}</strong>
            <div className="muted small">
              {step.at ? new Date(step.at).toLocaleString() : "Pending"}
            </div>
            {step.txHash ? (
              <a className="mono small" href={`https://sepolia.basescan.org/tx/${step.txHash}`} target="_blank" rel="noreferrer">
                {step.txHash}
              </a>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
