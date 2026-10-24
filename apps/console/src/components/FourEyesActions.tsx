import { SecondaryButton } from "./SecondaryButton.js";

export function FourEyesActions({ authorId, currentUserId, pending, onDecide }: {
  authorId: string;
  currentUserId: string;
  pending: boolean;
  onDecide: (decision: "approve" | "reject") => void;
}) {
  const isAuthor = authorId === currentUserId;
  return (
    <div className="row wrap">
      <SecondaryButton disabled={isAuthor || pending} onClick={() => onDecide("approve")} title={isAuthor ? "The author cannot approve this change" : pending ? "Another decision is being submitted" : "Approve this change"}>
        Approve
      </SecondaryButton>
      <SecondaryButton disabled={isAuthor || pending} onClick={() => onDecide("reject")} title={isAuthor ? "The author cannot reject their own change" : pending ? "Another decision is being submitted" : "Reject this change"}>
        Reject
      </SecondaryButton>
      {isAuthor ? <span className="muted small">Waiting for another member</span> : null}
    </div>
  );
}
