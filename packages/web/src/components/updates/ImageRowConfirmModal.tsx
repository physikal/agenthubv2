import { useState } from "react";

interface ImageRowConfirmModalProps {
  readonly displayName: string;
  readonly currentTag: string;
  readonly targetTag: string;
  readonly disruption: string;
  readonly isMajor: boolean;
  readonly onConfirm: (acknowledgedMajor: boolean) => void;
  readonly onCancel: () => void;
}

export function ImageRowConfirmModal(props: ImageRowConfirmModalProps): JSX.Element {
  const [acked, setAcked] = useState(false);
  const canConfirm = !props.isMajor || acked;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-md bg-zinc-900 p-6 shadow-xl">
        <h3 className="text-lg font-semibold">Update {props.displayName}</h3>
        <p className="mt-2 text-sm text-zinc-400">
          <code className="text-zinc-300">{props.currentTag}</code>
          {" → "}
          <code className="text-zinc-300">{props.targetTag}</code>
        </p>
        <p className="mt-3 text-sm text-zinc-300">{props.disruption}</p>
        {props.isMajor && (
          <label className="mt-4 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={acked}
              onChange={(e) => setAcked(e.target.checked)}
              className="mt-0.5"
            />
            <span className="text-amber-400">
              I understand this is a major version upgrade and may require migration.
            </span>
          </label>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => props.onConfirm(acked)}
          >
            Update
          </button>
        </div>
      </div>
    </div>
  );
}
