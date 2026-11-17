"use client";

import { useState } from "react";
import { Money, ErrorText } from "@/components/ui";
import { MIN_UNPRICED_REPAIR_COST, repairCostWithMinimum } from "@/lib/domain/repair";
import { inr } from "@/lib/domain/money";
import { StepCard, StepFigure, StepNoFigure } from "./StepCard";
import { REPAIR_SOURCE, repairLines, repairQuotePatch, repairQuoteProblem, repairStep, type RepairSourceId } from "./caseSteps";
import type { CaseOps } from "./ops";

/**
 * The quote typed in from the bench, the job sheet or another repairer: ONE amount and where it
 * comes from — the choice is the reason the server keeps with it (caseSteps.ts repairQuotePatch).
 */
function RepairQuoteForm({ ops, sources, onDone }: { ops: CaseOps; sources: RepairSourceId[]; onDone?: () => void }) {
  const [amount, setAmount] = useState("");
  const [source, setSource] = useState<RepairSourceId>(sources[0] ?? "job_sheet");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const outside = sources.length === 1 && sources[0] === "outside";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const patch = repairQuotePatch(amount, source);
    if (!patch) return setErr(repairQuoteProblem(amount));
    setBusy(true);
    const e2 = await ops.save(patch);
    setBusy(false);
    setErr(e2);
    if (!e2) {
      setAmount("");
      onDone?.();
    }
  }

  return (
    <form onSubmit={submit} className="rounded-[12px] border border-line p-3 sm:p-4 space-y-3">
      <label className="block">
        <span className="label">{outside ? "Customer's outside quote (₹)" : "Service centre's quote (₹)"}</span>
        <div className="flex gap-2">
          <input
            className="input num flex-1 min-w-0"
            inputMode="numeric"
            enterKeyHint="done"
            autoComplete="off"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setErr(null);
            }}
            placeholder={`e.g. ${MIN_UNPRICED_REPAIR_COST}`}
          />
          <button className="btn btn-primary shrink-0" disabled={busy || !amount.trim()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </label>
      {sources.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Where the quote comes from">
          {sources.map((s) => (
            <button key={s} type="button" className="chip !min-h-[38px]" aria-pressed={source === s} onClick={() => setSource(s)}>
              {REPAIR_SOURCE[s].label}
            </button>
          ))}
        </div>
      ) : null}
      <ErrorText error={err} />
    </form>
  );
}

/**
 * REPAIR QUOTE — what the customer pays to keep the phone:
 * - Uses Catalogue repair price book sum when quoted (existing logic).
 * - Uses ₹3,500 minimum (or partial book sum if higher) when broken parts are not in the price book.
 * - Repair payments are not accepted via Razorpay (if chosen, customer opted to repair and walked out).
 */
export function StepRepair({ ops }: { ops: CaseOps }) {
  const { view, editable, save } = ops;
  const [err, setErr] = useState<string | null>(null);
  const [override, setOverride] = useState(false);
  const s = repairStep(view);
  const lines = repairLines(view.repair);
  const noRepair = s.headline === "Nothing to repair" || s.headline === "Choose the phone first" || s.headline === "Not priced yet";
  const effectiveRepairAmount =
    s.amount !== null
      ? s.amount
      : noRepair
        ? null
        : repairCostWithMinimum(view.repair, { hasRepairNeed: true });

  const line =
    s.amount !== null || noRepair
      ? s.line
      : `${s.line ? `${s.line} ` : ""}Minimum repair estimate (${inr(MIN_UNPRICED_REPAIR_COST)}) applied when part repair cost is not in catalogue repair price book.`;

  const details =
    lines.length || view.manualRepair ? (
      <>
        {lines.length ? (
          <ul className="space-y-1 text-[14.5px]">
            {lines.map((l) => (
              <li key={l} className="num">
                {l}
              </li>
            ))}
          </ul>
        ) : null}
        {view.manualRepair ? <p className="text-[13.5px] text-muted">Entered by {view.manualRepair.by}.</p> : null}
      </>
    ) : null;

  return (
    <StepCard
      id="step-repair"
      title="Repair quote"
      figure={
        effectiveRepairAmount !== null ? (
          <StepFigure tone="fix">
            <Money value={effectiveRepairAmount} />
          </StepFigure>
        ) : (
          <StepNoFigure>{s.headline ?? "No repair needed"}</StepNoFigure>
        )
      }
      line={line}
      details={details}
    >
      {view.status === "repair_chosen" ? (
        <p className="text-[13.5px] text-ink-2">
          Customer opted to repair and walked out — no Razorpay payment is collected for repair.
        </p>
      ) : null}
      {editable && view.manualRepair ? (
        <button type="button" className="btn btn-sm" onClick={async () => setErr(await save({ manualRepair: null }, { manualRepair: null }))}>
          {view.repairNotServiced ? "Remove quote" : "Use price book"}
        </button>
      ) : null}
      {editable && s.form === "needed" ? <RepairQuoteForm ops={ops} sources={s.sources} /> : null}
      {editable && s.form !== "needed" ? (
        override ? (
          <RepairQuoteForm ops={ops} sources={s.sources.length ? s.sources : ["job_sheet", "bench"]} onDone={() => setOverride(false)} />
        ) : (
          <button type="button" className="btn btn-sm btn-ghost !px-0 text-fix" onClick={() => setOverride(true)}>
            Different quote?
          </button>
        )
      ) : null}
      {err ? <ErrorText error={err} /> : null}
    </StepCard>
  );
}
