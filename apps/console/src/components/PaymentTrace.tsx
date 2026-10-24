export interface TraceStep {
  step: string;
  at: string | Date | null;
  txHash: string | null;
}

export interface TraceRow extends TraceStep {
  done: boolean;
}

const BASE_STEPS = ["Agent request", "Guard visa", "Vault", "MPC signature", "Base broadcast", "Zodiac", "Confirmed"];
const STEP_LABELS: Record<string, string> = {
  "Agent request": "Agent request",
  "Guard visa": "Policy check",
  Vault: "Spending limit",
  "MPC signature": "Transaction signature",
  "Base broadcast": "Base submission",
  Zodiac: "Treasury permission",
  Confirmed: "Confirmed",
  Reverted: "Failed",
  Cancelled: "Cancelled",
};

function doneCount(state: string): number {
  switch (state) {
    case "Prepared":
      return 1;
    case "Escalated":
      return 1;
    case "PossiblySigned":
      return 4;
    case "Broadcast":
      return 5;
    case "Confirmed":
      return 7;
    case "Reverted":
      return 5;
    case "Cancelled":
      return 4;
    default:
      return 1;
  }
}

export function sequenceTrace(steps: TraceStep[], state: string): TraceRow[] {
  const limit = doneCount(state);
  return steps.map((step, index) => {
    const baseIndex = BASE_STEPS.indexOf(step.step);
    if (baseIndex === -1) {
      return { ...step, done: step.step === "Reverted" ? state === "Reverted" : state === "Cancelled" };
    }
    return { ...step, done: index < limit || baseIndex < limit };
  });
}

export function PaymentTrace({ steps, state }: { steps: TraceStep[]; state: string }) {
  return (
    <ol className="trace" aria-label="Payment trace">
      {sequenceTrace(steps, state).map((step) => (
        <li key={step.step} className={step.done ? "trace-step done" : "trace-step"}>
          <div className="trace-dot" aria-hidden="true" />
          <div className="trace-body">
            <strong>{STEP_LABELS[step.step] ?? "Unrecognized step"}</strong>
            <div className="muted small">
              {step.done ? (step.at ? new Date(step.at).toLocaleString() : "Done") : "Pending"}
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
