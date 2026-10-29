import React from "react";
import { TrendingUp, TrendingDown } from "lucide-react";

/* ---------------- responsive ---------------- */
// True when the viewport is phone-sized. Drives the sidebar→drawer swap and
// the collapse of fixed multi-column grids to a single column.
export const MOBILE_BP = 760;
export function useIsMobile(breakpoint = MOBILE_BP) {
  const query = `(max-width: ${breakpoint}px)`;
  const get = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false);
  const [isMobile, setIsMobile] = React.useState(get);
  React.useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setIsMobile(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return isMobile;
}

/* ---------------- constants ---------------- */
export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Month keys are "YYYY-MM". These helpers let the app reach any month, not a fixed list.
export const monthLabelFor = (key) => {
  const [y, m] = key.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
};
export const addMonths = (key, n) => {
  const [y, m] = key.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
};
export const monthRange = (startKey, endKey) => {
  const out = [];
  let k = startKey;
  for (let i = 0; k <= endKey && i < 600; i++) { out.push({ key: k, label: monthLabelFor(k) }); k = addMonths(k, 1); }
  return out;
};
export const thisMonthKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

// The month the app opens on and treats as "now". Resolves at load time to the
// real current month (was a frozen string before — which drifted out of date).
export const CURRENT_MONTH = thisMonthKey();

// Period grouping for the Summary view.
export const periodKeyFor = (monthKey, grouping) => {
  const [y, m] = monthKey.split("-").map(Number);
  if (grouping === "year") return `${y}`;
  if (grouping === "quarter") return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
  return monthKey;
};
export const periodLabelFor = (periodKey, grouping) => {
  if (grouping === "year") return periodKey;
  if (grouping === "quarter") { const [y, q] = periodKey.split("-Q"); return `Q${q} ${y}`; }
  return monthLabelFor(periodKey);
};

// A generous default list (the app extends past it via prev/next navigation).
export const MONTHS = monthRange("2025-07", addMonths("2025-07", 19));

export const EXPENSE_CATEGORIES = [
  "Repairs", "Maintenance", "Utilities", "Water/Sewer", "Insurance",
  "Property tax", "Mortgage", "Legal", "Supplies", "Management", "Other",
];

export const STATUS = {
  paid:    { label: "Paid",    fg: "#0f7a54", bg: "#e3f3ec", dot: "#12a06e" },
  partial: { label: "Partial", fg: "#9a6511", bg: "#fbf0d9", dot: "#e0a326" },
  owed:    { label: "Owed",    fg: "#a83232", bg: "#f8e5e2", dot: "#d24b4b" },
  none:    { label: "Owed",    fg: "#a83232", bg: "#f8e5e2", dot: "#d24b4b" },
  future:  { label: "—",       fg: "#8a8681", bg: "#efece5", dot: "#cfc9bd" },
};

/* ---------------- helpers ---------------- */
export const money = (n) =>
  (n < 0 ? "-" : "") + "$" + Math.abs(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ---------------- CSV export ---------------- */
// Build a CSV string from a header row + array of rows (each an array of cells).
export function toCSV(headers, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
}
// Trigger a client-side download of a CSV file (no server, no dependency).
export function downloadCSV(filename, headers, rows) {
  if (typeof document === "undefined") return;
  const blob = new Blob(["﻿" + toCSV(headers, rows)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// Plain numeric string for CSV money cells (no $ or commas, 2 dp).
export const csvNum = (n) => (Number(n) || 0).toFixed(2);

export function reconcile(pay, tenant) {
  const govt = +pay?.govt || 0;
  const portion = +pay?.portion || 0;
  const assistance = +pay?.assistance || 0;
  const total = govt + portion + assistance;
  const rent = +tenant?.lease_rent || 0;
  const variance = total - rent;
  let status = "owed";
  if (total > 0.001) status = variance >= -0.5 ? "paid" : "partial";
  return { govt, portion, assistance, total, rent, variance, status };
}

export function applicableTerm(sortedTermsAsc, monthKey) {
  const monthStart = monthKey + "-01";
  let chosen = null;
  for (const term of sortedTermsAsc) {
    if (term.effective_from <= monthStart) chosen = term; else break;
  }
  return chosen;
}

export function buildLedger(tenants, terms, rawPayments, currentMonth) {
  const payMap = {};
  rawPayments.forEach((p) => { payMap[`${p.tenant_id}:${p.month}`] = p; });

  const termsByTenant = {};
  terms.forEach((t) => { (termsByTenant[t.tenant_id] = termsByTenant[t.tenant_id] || []).push(t); });
  Object.values(termsByTenant).forEach((arr) => arr.sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1)));

  const payMonths = rawPayments.map((p) => p.month).sort();
  const ledgerStart = payMonths[0] || currentMonth;
  // Run the ledger through whichever is latest: the requested month, the last
  // month with data, or today — so added/future months are always included.
  const lastPay = payMonths[payMonths.length - 1] || currentMonth;
  const through = [currentMonth, lastPay, thisMonthKey()].sort().pop();
  const monthsDue = monthRange(ledgerStart, through < ledgerStart ? ledgerStart : through);

  return tenants.map((t) => {
    const tterms = termsByTenant[t.id] || [];
    const firstTermMonth = tterms.length ? tterms[0].effective_from.slice(0, 7) : ledgerStart;
    // An archived tenant stops accruing after the month they were archived, so
    // their arrears reflect only the months they actually occupied the unit.
    const archMonth = t.active === false ? (t.archived_at || "").slice(0, 7) : "";
    let govtBal = 0, tenantBal = 0;
    const detail = [];
    monthsDue.forEach((m) => {
      if (m.key < firstTermMonth) return;
      if (archMonth && m.key > archMonth) return;
      const term = applicableTerm(tterms, m.key) || { lease_rent: t.lease_rent, govt_expected: t.govt_default, tenant_expected: t.portion_default };
      const pay = payMap[`${t.id}:${m.key}`];
      const govtRec = pay ? (+pay.govt + +pay.assistance) : 0;
      // Credit any "extra / other" collected to the tenant side, so extra
      // payments reduce what's owed (otherwise the ledger ignores them).
      const tenRec = pay ? (+pay.portion + (+pay.extra || 0)) : 0;
      const govtShort = (+term.govt_expected) - govtRec;
      const tenShort = (+term.tenant_expected) - tenRec;
      govtBal += govtShort; tenantBal += tenShort;
      detail.push({
        month: m.key, label: m.label,
        govtExpected: +term.govt_expected, tenantExpected: +term.tenant_expected,
        govtRec, tenRec, govtShort, tenShort, govtBal, tenantBal,
      });
    });
    return { t, govtBal, tenantBal, totalBal: govtBal + tenantBal, detail };
  });
}

/* ---------------- atoms ---------------- */
export function Money({ v, bold, size = 14, dim }) {
  return (
    <span style={{
      fontFamily: "'IBM Plex Mono',monospace", fontSize: size,
      fontWeight: bold ? 600 : 500, fontVariantNumeric: "tabular-nums",
      color: dim ? "#9a958c" : "#1c2836", whiteSpace: "nowrap",
    }}>{money(v)}</span>
  );
}

export function Variance({ v }) {
  if (Math.abs(v) < 0.5) return <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, color: "#9a958c" }}>—</span>;
  const up = v > 0;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, fontWeight: 600, color: up ? "#0f7a54" : "#a83232" }}>
      {up ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
      {money(Math.abs(v))}
    </span>
  );
}

export function Stamp({ status }) {
  const s = STATUS[status] || STATUS.owed;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px",
      borderRadius: 6, background: s.bg, color: s.fg, fontSize: 11.5, fontWeight: 700,
      letterSpacing: ".04em", textTransform: "uppercase", fontFamily: "'Space Grotesk',sans-serif",
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: s.dot }} />
      {s.label}
    </span>
  );
}

export function UnitChip({ unit, big }) {
  return (
    <span style={{
      fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: big ? 13 : 11.5,
      color: "#7a5c17", background: "#f6ecd2", border: "1px solid #e6d3a4",
      padding: big ? "6px 9px" : "3px 7px", borderRadius: 6, whiteSpace: "nowrap",
    }}>{unit}</span>
  );
}

export function Legend({ dot, label }) {
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 8, height: 8, borderRadius: "50%", background: dot }} />{label}</span>;
}

export function BigStat({ label, value, sub, accent }) {
  return (
    <div style={{ ...S.card, padding: "16px 18px" }}>
      <div style={{ fontSize: 11.5, color: "#8a8681", textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 600 }}>{label}</div>
      <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 25, fontWeight: 600, color: accent, marginTop: 6, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ fontSize: 12, color: "#a29d92", marginTop: 3 }}>{sub}</div>
    </div>
  );
}

/* ---------------- style constants ---------------- */
export const S = {
  page: { display: "flex", height: "100vh", width: "100%", background: "#f4f1ea", fontFamily: "'Inter',sans-serif", color: "#1c2836", overflow: "hidden" },
  sidebar: { width: 234, background: "#161f2b", display: "flex", flexDirection: "column", flexShrink: 0 },
  // mobile chrome: a white top bar with a hamburger + month picker, and a dark slide-in drawer
  mtopbar: { display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", background: "#161f2b", flexShrink: 0 },
  hamburger: { display: "flex", alignItems: "center", justifyContent: "center", width: 38, height: 38, borderRadius: 9, border: "1px solid rgba(255,255,255,.12)", background: "rgba(255,255,255,.04)", color: "#f4f1ea", flexShrink: 0 },
  drawerOverlay: { position: "fixed", inset: 0, background: "rgba(9,13,19,.55)", zIndex: 60, display: "flex" },
  drawer: { width: 250, maxWidth: "82%", background: "#161f2b", height: "100%", display: "flex", flexDirection: "column", boxShadow: "4px 0 30px rgba(0,0,0,.4)" },
  brassPlaque: { width: 34, height: 34, borderRadius: 8, background: "linear-gradient(150deg,#e7c56b,#b8892b)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  navBtn: { display: "flex", alignItems: "center", gap: 11, width: "100%", padding: "10px 12px", marginBottom: 3, borderRadius: 8, border: "none", background: "transparent", fontSize: 13.5, fontWeight: 500, textAlign: "left" },
  topbar: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 28px", background: "#fff", borderBottom: "1px solid #e8e3d8", flexShrink: 0 },
  monthSelect: { padding: "8px 12px", borderRadius: 8, border: "1px solid #e2ddd0", background: "#faf8f3", fontFamily: "'Space Grotesk',sans-serif", fontWeight: 600, fontSize: 13.5, color: "#1c2836", cursor: "pointer" },
  card: { background: "#fff", border: "1px solid #ece7dc", borderRadius: 12, padding: 18, boxShadow: "0 1px 2px rgba(30,24,10,.03)" },
  cardTitle: { fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 14.5, color: "#1c2836" },
  th: { textAlign: "left", padding: "11px 14px", fontSize: 11, fontWeight: 700, color: "#8a8681", textTransform: "uppercase", letterSpacing: ".04em", borderBottom: "1px solid #ece7dc", background: "#faf8f3", whiteSpace: "nowrap" },
  td: { padding: "11px 14px", fontSize: 13, verticalAlign: "middle" },
  cellInput: { border: "1px solid #e2ddd0", borderRadius: 7, padding: "7px 9px", fontSize: 13, fontFamily: "'IBM Plex Mono',monospace", color: "#1c2836", background: "#fdfcf9" },
  attnRow: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #f0ece3" },
  pill: { display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 13px", borderRadius: 7, fontSize: 12.5, fontWeight: 600 },
  primaryBtn: { display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 8, border: "none", background: "#161f2b", color: "#f4d488", fontWeight: 600, fontSize: 13.5 },
  ghostBtn: { padding: "9px 16px", borderRadius: 8, border: "1px solid #e2ddd0", background: "#fff", color: "#5a5850", fontWeight: 600, fontSize: 13.5 },
  linkBtn: { display: "inline-flex", alignItems: "center", gap: 3, border: "none", background: "transparent", color: "#b8892b", fontWeight: 600, fontSize: 12.5 },
  iconBtn: { border: "none", background: "transparent", color: "#8a8681", display: "flex", padding: 4 },
  overlay: { position: "fixed", inset: 0, background: "rgba(22,31,43,.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 50 },
  modal: { background: "#fff", borderRadius: 14, padding: 24, width: 560, maxWidth: "100%", maxHeight: "90vh", overflow: "auto", boxShadow: "0 20px 60px rgba(0,0,0,.3)" },
  field: { width: "100%", border: "1px solid #e2ddd0", borderRadius: 8, padding: "9px 11px", fontSize: 13.5, fontFamily: "'Inter',sans-serif", color: "#1c2836", background: "#fdfcf9" },
};
