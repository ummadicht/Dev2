/**
 * Regression tests for GET /cases/[id] (Server Components render path), dual-DB parameter
 * translation, malformed/legacy rows, partner isolation, and Razorpay receipt formatting.
 */
import "./testing/register.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "swapup-case-reg-"));
process.env.SWAPUP_DB = join(dir, "test.db");
process.env.GRADEIQ_ENABLED = "0";
for (const k of Object.keys(process.env)) if (k.startsWith("PRICEIQ_") || k.startsWith("PHONECHECK_") || k.startsWith("GEMINI_")) delete process.env[k];

const origLog = console.log;
console.log = () => {};
const { ensureSeeded } = await import("./seed.ts");
await ensureSeeded();
const { db, toPgSql, toSqliteSql } = await import("./db.ts");
const cases = await import("./cases.ts");
const { getCaseForViewer } = await import("./counter-extra.ts");
const pc = await import("./phonecheck.ts");
const gr = await import("./gradingReport.ts");
const rzp = await import("./razorpay.ts");

after(() => {
  console.log = origLog;
  rmSync(dir, { recursive: true, force: true });
});

type U = import("./auth.ts").SessionUser;
function who(username: string): U {
  const r = db().prepare(`SELECT id, username, name, role, org_id, store_id FROM users WHERE username = ?`).get(username) as {
    id: string;
    username: string;
    name: string;
    role: U["role"];
    org_id: string;
    store_id: string | null;
  };
  return { id: r.id, username: r.username, name: r.name, role: r.role, orgId: r.org_id, storeId: r.store_id, exp: Date.now() + 3_600_000 };
}

const adv = who("advisor");
const korAdv = who("advisor.kor");
const partner = who("partner");

test("getCaseForViewer tolerates legacy nullable columns, non-array faults/variants, partial quote/repair JSON, and malformed grading_reports", async () => {
  const created = await cases.createCase(adv, { customerName: "Legacy Customer", customerPhone: "9820012345" });
  const now = new Date().toISOString();

  // Simulate legacy / partially migrated columns that previously threw inside toView / offer / gradingReportFor.
  db()
    .prepare(
      `UPDATE cases SET advisor_id = 'usr_deleted_legacy', report_token = NULL, faults = ?, repair = ?, quote = ?, status = 'locked', locked_at = ?, updated_at = ? WHERE id = ?`
    )
    .run(
      '{"unexpected":"object"}',
      JSON.stringify({ total: 5000, gst: 763, labor: 425, customerPays: 5000 }),
      JSON.stringify({ status: "priced", amount: 22000 }),
      now,
      now,
      created.id
    );
  db()
    .prepare(
      `INSERT INTO grading_reports (id, case_id, version, reason, ruleset, status, label, final, body, sha256, photo_sources, issued_at, issued_by)
       VALUES (?, ?, 1, 'initial', 'v1', 'graded', 'Good', 1, '{bad-json', 'deadbeef', 'not-an-array', ?, ?)`
    )
    .run("rep_bad_1", created.id, now, adv.id);

  const view = await getCaseForViewer(adv, created.id);
  assert.equal(view.id, created.id);
  assert.deepEqual(view.faults, []);
  assert.equal(view.advisorName, null);
  assert.equal(view.quote?.amount, 22000);
  assert.equal(view.repair?.customerPays, 5000);

  // Grading report helper returns cleanly even when persisted body JSON is corrupt.
  const report = await gr.gradingReportFor(adv, created.id);
  assert.equal(report.issued, null);

  // Partner viewer remains isolated: receives case but no private fields or internal refurb/offer details.
  const pView = await getCaseForViewer(partner, created.id);
  assert.equal(pView.customer, null);
  assert.equal(pView.offer, null);
  assert.equal(pView.refurbEconomics, null);
  assert.equal(pView.payable, null);

  // Another store's advisor receives 404 (multi-tenant isolation preserved).
  await assert.rejects(getCaseForViewer(korAdv, created.id), (e: Error & { status?: number }) => e.status === 404);
});

test("phonecheckForCase handles null and populated IMEIs on SQLite and preserves contiguous PG placeholders", async () => {
  const noImei = await cases.createCase(adv, { customerName: "No IMEI Case" });
  const r1 = await pc.phonecheckForCase(adv, noImei.id);
  assert.deepEqual(r1.records, []);

  const withImei = await cases.createCase(adv, { customerName: "With IMEI Case" });
  await cases.updateCase(adv, withImei.id, { imei: "353950100000117" });
  const r2 = await pc.phonecheckForCase(adv, withImei.id);
  assert.deepEqual(r2.records, []);

  // Verify SQL translation helpers never leave broken $? placeholders or mis-ordered bindings.
  const qNoImei = toSqliteSql(
    `SELECT * FROM phonecheck_records WHERE (case_id = $1 ) AND (store_id IS NULL OR store_id = $2)`,
    ["c1", "st1"]
  );
  assert.deepEqual(qNoImei.params, ["c1", "st1"]);
  const qWithImei = toSqliteSql(
    `SELECT * FROM phonecheck_records WHERE (case_id = $1 OR imei = ANY($2::text[]) OR imei2 = ANY($2::text[])) AND (store_id IS NULL OR store_id = $3)`,
    ["c1", ["111", "222"], "st1"]
  );
  assert.deepEqual(qWithImei.params, ["c1", "111", "222", "111", "222", "st1"]);
  assert.match(toPgSql("SELECT * FROM cases WHERE faults = ? AND id = ?"), /\$1.*\$2/);
});

test("razorpay receipt email fallback handles legacy unknown payment_plan labels cleanly", async () => {
  const c = await cases.createCase(adv, { customerName: "Pay Case", customerPhone: "9820012345" });
  const now = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO razorpay_payments (id, case_id, case_ref, org_id, store_id, journey, payment_plan, installment_stage, total_case_payable, amount, remaining_due, currency, razorpay_order_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'repair', ?, 'advance', 5000, 1500, 3500, 'INR', 'order_legacy_1', 'paid', ?)`
    )
    .run("rzp_legacy_1", c.id, c.ref, adv.orgId, adv.storeId!, "legacy_custom_plan", now);

  const summary = await rzp.getCaseRazorpaySummary(c.id);
  assert.equal(summary.repair.paidAmount, 1500);
  const receipt = await rzp.sendCaseReceiptEmail(adv, { caseId: c.id, toEmail: "customer@example.invalid" });
  assert.equal(receipt.ok, true);
  assert.match(receipt.text, /legacy_custom_plan/);
});

test("razorpay rejects repair checkout, uses 3500 minimum for unpriced parts, and prints walk-out repair bill", async () => {
  const c = await cases.createCase(adv, { customerName: "Walkout Repair", customerPhone: "9820012346" });
  const now = new Date().toISOString();
  db()
    .prepare(`UPDATE cases SET status = 'repair_chosen', faults = ?, closed_at = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(["mic"]), now, now, c.id);

  const summary = await rzp.getCaseRazorpaySummary(c.id);
  assert.equal(summary.repair.totalPayable, 3500);
  assert.equal(summary.repair.paidAmount, 0);

  await assert.rejects(
    rzp.createRazorpayOrder(adv, {
      caseId: c.id,
      journey: "repair",
      paymentPlan: "repair_full",
    }),
    (e: Error & { status?: number }) => e.status === 400 && /walked out/i.test(e.message)
  );

  const bill = await rzp.sendCaseReceiptEmail(adv, { caseId: c.id, toEmail: "walkout@example.invalid" });
  assert.equal(bill.ok, true);
  assert.match(bill.text, /₹3,500/);
  assert.match(bill.text, /opted to repair and walked out/i);
  assert.doesNotMatch(bill.html, /Paid via Razorpay/);
});

