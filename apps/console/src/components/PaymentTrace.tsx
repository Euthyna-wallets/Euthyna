export interface TraceStep {
  step: string;
  at: string | Date | null;
  txHash: string | null;
}

export interface TraceRow extends TraceStep {
  done: boolean;
}

export function sequenceTrace(steps: TraceStep[]): TraceRow[] {
  let previousDone = true;
  return steps.map((step) => {
    const done = previousDone && Boolean(step.at);
    previousDone = done;
    return { ...step, done };
  });
}

export function PaymentTrace({ steps }: { steps: TraceStep[] }) {
  return (
    <ol className="trace" aria-label="Payment trace">
      {sequenceTrace(steps).map((step) => (
        <li key={step.step} className={step.done ? "trace-step done" : "trace-step"}>
          <div className="trace-dot" aria-hidden="true" />
          <div className="trace-body">
            <strong>{step.step}</strong>
            <div className="muted small">{step.done ? new Date(step.at!).toLocaleString() : "Pending"}</div>
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
