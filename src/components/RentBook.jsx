import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  Building2, LayoutDashboard, Receipt, Users, Grid3x3, Car,
  Check, Phone, Plus, X, Search, CalendarClock, Banknote, Pencil,
  ChevronRight, ChevronDown, ChevronLeft, Landmark, Wallet, LogOut, Trash2,
  StickyNote, TrendingUp, Menu, Clock, AlertTriangle, Archive, MapPin, BarChart3,
} from "lucide-react";
import {
  tenantsApi, parkingApi, paymentsApi, rentTermsApi, expensesApi, notesApi, authApi, realtime,
  propertiesApi, auditApi,
} from "../lib/db";
import {
  S, STATUS, CURRENT_MONTH, EXPENSE_CATEGORIES, money, reconcile, buildLedger,
  Money, Variance, Stamp, UnitChip, Legend, BigStat, useIsMobile,
  addMonths, monthRange, monthLabelFor, thisMonthKey, periodKeyFor, periodLabelFor,
} from "../lib/ui";

// True once `month` (a "YYYY-MM" key) has reached one calendar month before
// `leaseStart`. Tenants with no lease start on file are always shown.
function monthReached(leaseStart, month) {
  if (!leaseStart) return true;
  const [ly, lm] = leaseStart.slice(0, 7).split("-").map(Number);
  const gy = lm === 1 ? ly - 1 : ly;
  const gm = lm === 1 ? 12 : lm - 1;
  const gate = `${gy}-${String(gm).padStart(2, "0")}`;
  return month >= gate; // zero-padded YYYY-MM compares lexically
}

export default function RentBook({ session, role }) {
  const [view, setView] = useState("overview");
  const [month, setMonth] = useState(CURRENT_MONTH);
  const [tenants, setTenants] = useState([]);
  const [rentTerms, setRentTerms] = useState([]);
  const [parking, setParking] = useState([]);
  const [monthStatus, setMonthStatus] = useState([]);
  const [parkingPaid, setParkingPaid] = useState({});
  const [parkingNotes, setParkingNotes] = useState({});
  const [rawPayments, setRawPayments] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [notes, setNotes] = useState([]);
  const [audit, setAudit] = useState([]);
  const [allStatus, setAllStatus] = useState([]);
  const [allParkPaid, setAllParkPaid] = useState([]);
  const [editTenant, setEditTenant] = useState(null);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [live, setLive] = useState(false);
  const [properties, setProperties] = useState([]);
  const [propertyId, setPropertyId] = useState(null);
  const [toast, setToast] = useState(null); // { kind: 'error'|'ok', text }
  const isMobile = useIsMobile();
  const email = session?.user?.email || "";
  const flash = useCallback((kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), kind === "error" ? 6000 : 2500); }, []);

  const loadStatic = useCallback(async () => {
    if (!propertyId) return;
    const [t, p, rt, ex, no] = await Promise.all([
      tenantsApi.list(propertyId), parkingApi.list(propertyId), rentTermsApi.list(), expensesApi.list(propertyId), notesApi.list(propertyId),
    ]);
    setTenants(t.data || []);
    setParking(p.data || []);
    setRentTerms(rt.data || []);
    setExpenses(ex.data || []);
    setNotes(no.data || []);
  }, [propertyId]);

  const loadMonth = useCallback(async (m) => {
    const [st, pp] = await Promise.all([paymentsApi.statusForMonth(m), parkingApi.paidForMonth(m)]);
    setMonthStatus(st.data || []);
    const map = {}, notesMap = {};
    (pp.data || []).forEach((r) => { map[r.spot_id] = +r.amount || 0; notesMap[r.spot_id] = r.notes || ""; }); // spot_id -> received $ / note
    setParkingPaid(map);
    setParkingNotes(notesMap);
  }, []);

  const loadLedger = useCallback(async () => {
    const { data } = await paymentsApi.allRaw();
    setRawPayments(data || []);
  }, []);

  const loadAudit = useCallback(async () => {
    if (!propertyId) return;
    const { data } = await auditApi.recent(propertyId, 200);
    setAudit(data || []);
  }, [propertyId]);

  const loadSummary = useCallback(async () => {
    const [st, pp] = await Promise.all([paymentsApi.allStatus(), parkingApi.allPaid()]);
    setAllStatus(st.data || []);
    setAllParkPaid(pp.data || []);
  }, []);

  // Pick the active property once on mount (restoring the last choice).
  useEffect(() => {
    (async () => {
      const { data } = await propertiesApi.list();
      const list = data || [];
      setProperties(list);
      const stored = typeof localStorage !== "undefined" ? localStorage.getItem("rb_property") : null;
      const pid = (stored && list.some((p) => p.id === stored)) ? stored : (list[0]?.id || null);
      setPropertyId(pid);
      if (!pid) setLoading(false);
    })();
  }, []);

  useEffect(() => { if (propertyId && typeof localStorage !== "undefined") localStorage.setItem("rb_property", propertyId); }, [propertyId]);

  // Load the property's data whenever the active property changes.
  useEffect(() => {
    if (!propertyId) return;
    (async () => {
      setLoading(true);
      await loadStatic();
      await loadMonth(month);
      setLoading(false);
    })();
  }, [propertyId]); // eslint-disable-line

  useEffect(() => { loadMonth(month); }, [month, loadMonth]);
  useEffect(() => { if (view === "ledger") loadLedger(); }, [view, loadLedger]);
  useEffect(() => { if (view === "activity") loadAudit(); }, [view, loadAudit]);
  useEffect(() => { if (view === "summary") loadSummary(); }, [view, loadSummary]);

  // Live sync: subscribe once to Postgres change webhooks and reload only the
  // slices a given change touches. Refs keep the subscription stable across
  // month/view changes so we don't tear the websocket down and back up.
  const monthRef = useRef(month);
  const viewRef = useRef(view);
  useEffect(() => { monthRef.current = month; }, [month]);
  useEffect(() => { viewRef.current = view; }, [view]);

  useEffect(() => {
    const debounce = {};
    const run = (key, fn) => { clearTimeout(debounce[key]); debounce[key] = setTimeout(fn, 250); };
    const unsub = realtime.subscribe(
      ({ table }) => {
        if (["tenants", "rent_terms", "parking_spots", "expenses", "notes"].includes(table)) run("static", loadStatic);
        if (["payments", "parking_payments"].includes(table)) run("month", () => loadMonth(monthRef.current));
        if (["payments", "rent_terms"].includes(table) && viewRef.current === "ledger") run("ledger", loadLedger);
      },
      (status) => setLive(status === "SUBSCRIBED"),
    );
    return () => { Object.values(debounce).forEach(clearTimeout); unsub(); };
  }, [loadStatic, loadMonth, loadLedger]);

  const activeTenants = useMemo(() => tenants.filter((t) => t.active !== false), [tenants]);
  const statusMap = useMemo(() => {
    const m = {};
    monthStatus.forEach((r) => { m[r.tenant_id] = r; });
    return m;
  }, [monthStatus]);
  const monthExpenses = useMemo(() => expenses.filter((e) => (e.spent_on || "").slice(0, 7) === month), [expenses, month]);

  const setPay = useCallback(async (tenantId, field, value) => {
    const cur = statusMap[tenantId] || {};
    const row = {
      tenant_id: tenantId, month,
      govt: field === "govt" ? value : (cur.govt || 0),
      portion: field === "portion" ? value : (cur.portion || 0),
      assistance: field === "assistance" ? value : (cur.assistance || 0),
      extra: field === "extra" ? value : (cur.extra || 0),
      check_num: field === "check_num" ? value : (cur.check_num || ""),
      bank_confirm: field === "bank_confirm" ? value : (cur.bank_confirm || false),
      notes: field === "notes" ? value : (cur.notes || ""),
    };
    const { error } = await paymentsApi.save(row);
    if (error) { flash("error", `Couldn't save — ${error.message}. Try again.`); return; }
    await loadMonth(month);
  }, [statusMap, month, loadMonth, flash]);

  const roll = useMemo(() => {
    let expected = 0, collected = 0, govtTotal = 0, portionTotal = 0, assistanceTotal = 0, extraTotal = 0, paidCt = 0, partialCt = 0, owedCt = 0;
    // A tenant only enters the roll once the viewing month reaches one month
    // before their lease start — or as soon as they have a payment that month.
    const visible = activeTenants.filter((t) => monthReached(t.lease_start, month) || statusMap[t.id]);
    const rows = visible.map((t) => {
      const s = statusMap[t.id];
      const r = s
        ? { govt: +s.govt, portion: +s.portion, assistance: +s.assistance, extra: +s.extra || 0, total: +s.total, rent: +s.lease_rent, variance: +s.variance, status: s.status }
        : { ...reconcile(null, t), extra: 0 };
      const pay = s
        ? { govt: s.govt, portion: s.portion, assistance: s.assistance, extra: s.extra, check_num: s.check_num, bank_confirm: s.bank_confirm, notes: s.notes }
        : {};
      expected += r.rent; collected += r.total; govtTotal += r.govt; portionTotal += r.portion; assistanceTotal += r.assistance; extraTotal += r.extra || 0;
      if (r.status === "paid") paidCt++; else if (r.status === "partial") partialCt++; else owedCt++;
      return { t, r, pay };
    });
    return { rows, expected, collected, govtTotal, portionTotal, assistanceTotal, extraTotal, outstanding: expected - collected, paidCt, partialCt, owedCt };
  }, [activeTenants, statusMap, month]);

  const leaseAlerts = useMemo(() => {
    const ref = new Date(month + "-01");
    return activeTenants
      .filter((t) => t.lease_end)
      .map((t) => ({ t, end: new Date(t.lease_end), days: Math.round((new Date(t.lease_end) - ref) / 86400000) }))
      .filter((x) => x.days <= 120)
      .sort((a, b) => a.days - b.days);
  }, [activeTenants, month]);

  const saveTenant = async (t) => {
    const payload = { ...t };
    if (!payload.id) { delete payload.id; payload.property_id = propertyId; }
    const { data, error } = await tenantsApi.upsert(payload);
    if (error) { flash("error", `Couldn't save tenant — ${error.message}`); return; }
    if (!t.id && data) {
      // The govt/tenant split is recorded per month in Collections, so the
      // starting term just carries the lease total (govt assumed to cover it).
      await rentTermsApi.add({
        tenant_id: data.id,
        effective_from: t.lease_start || `${CURRENT_MONTH}-01`,
        lease_rent: t.lease_rent, govt_expected: t.lease_rent, tenant_expected: 0,
        note: "Initial term",
      });
    }
    await loadStatic();
    flash("ok", "Tenant saved");
    setEditTenant(null);
  };
  const archiveTenant = async (id, active) => {
    const { error } = await tenantsApi.setActive(id, active);
    if (error) { flash("error", error.message); return; }
    await loadStatic();
    flash("ok", active ? "Tenant reactivated" : "Tenant archived");
    setEditTenant(null);
  };
  const deleteTenant = async (id) => {
    const { error } = await tenantsApi.remove(id);
    if (error) { flash("error", `Couldn't delete — ${error.message}`); return; }
    await loadStatic();
    flash("ok", "Tenant deleted");
    setEditTenant(null);
  };
  const addTerm = async (row) => { await rentTermsApi.add(row); await loadStatic(); };
  const removeTerm = async (id) => { await rentTermsApi.remove(id); await loadStatic(); };
  const addExpense = async (row) => { const { error } = await expensesApi.add({ ...row, property_id: propertyId }); if (error) return flash("error", error.message); await loadStatic(); };
  const removeExpense = async (id) => { await expensesApi.remove(id); await loadStatic(); };
  const addNote = async (row) => { const { error } = await notesApi.add({ ...row, author_email: email, property_id: propertyId }); if (error) return flash("error", error.message); await loadStatic(); };
  const removeNote = async (id) => { await notesApi.remove(id); await loadStatic(); };
  // Record the amount actually received for a parking spot this month (reconciled).
  const setParkingReceived = useCallback(async (spotId, amount) => {
    const amt = +amount || 0;
    setParkingPaid((p) => ({ ...p, [spotId]: amt }));
    const { error } = await parkingApi.setReceived(spotId, month, amt);
    if (error) { flash("error", `Couldn't save parking — ${error.message}`); loadMonth(month); }
  }, [month, flash, loadMonth]);
  // Save a free-text note for a parking spot this month.
  const setParkingNote = useCallback(async (spotId, note) => {
    setParkingNotes((n) => ({ ...n, [spotId]: note }));
    const { error } = await parkingApi.setNote(spotId, month, note);
    if (error) { flash("error", `Couldn't save parking note — ${error.message}`); loadMonth(month); }
  }, [month, flash, loadMonth]);
  // Deactivate / reactivate a parking spot (kept out of future months once they stop).
  const setParkingActive = useCallback(async (spotId, active) => {
    const { error } = await parkingApi.setActive(spotId, active);
    if (error) { flash("error", `Couldn't update spot — ${error.message}`); return; }
    await loadStatic();
  }, [flash, loadStatic]);

  // Parking spots visible for the month being viewed. An inactive spot still
  // shows in the months it was active (it has payment/note data, or the month
  // is before it was deactivated) but drops out of later months.
  const visibleParking = useMemo(() => parking.filter((p) => {
    if (p.active !== false) return true;                                // still active → every month
    if ((+parkingPaid[p.id] || 0) > 0.001 || (parkingNotes[p.id] || "").trim() !== "") return true; // activity this month
    const arch = (p.archived_at || "").slice(0, 7);                    // 'YYYY-MM' it was deactivated
    return arch !== "" && month < arch;                                // months before deactivation
  }), [parking, parkingPaid, parkingNotes, month]);

  const NAV = [
    { id: "overview", label: "Overview", icon: LayoutDashboard },
    { id: "collections", label: "Collections", icon: Receipt },
    { id: "ledger", label: "Arrears ledger", icon: Grid3x3 },
    { id: "expenses", label: "Expenses", icon: Wallet },
    { id: "tenants", label: "Tenants", icon: Users },
    { id: "parking", label: "Parking", icon: Car },
    { id: "summary", label: "Summary", icon: BarChart3 },
    { id: "log", label: "Log", icon: StickyNote },
    { id: "activity", label: "Activity", icon: Clock },
  ];
  const activeProperty = properties.find((p) => p.id === propertyId);
  const monthLabel = monthLabelFor(month);
  // Month list spans a generous window and always stretches to include the
  // selected month, so the prev/next arrows can reach any month on demand.
  const monthOptions = useMemo(() => {
    const start = month < "2025-07" ? month : "2025-07";
    let end = addMonths(thisMonthKey(), 18);
    if (month > end) end = month;
    if (CURRENT_MONTH > end) end = CURRENT_MONTH;
    return monthRange(start, end);
  }, [month]);
  const shiftMonth = useCallback((n) => setMonth((mm) => addMonths(mm, n)), []);
  const modalTerms = editTenant && editTenant !== "new" ? rentTerms.filter((rt) => rt.tenant_id === editTenant.id) : [];
  const modalNotes = editTenant && editTenant !== "new" ? notes.filter((n) => n.tenant_id === editTenant.id) : [];
  const buildingNotes = useMemo(() => notes.filter((n) => !n.tenant_id), [notes]);

  const go = (id) => { setView(id); setDrawerOpen(false); };

  // Shared dark-panel contents — rendered in the desktop sidebar and the mobile drawer.
  const railInner = (
    <>
      <div style={{ padding: "22px 20px 16px", borderBottom: "1px solid rgba(255,255,255,.08)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={S.brassPlaque}><Building2 size={18} color="#1a222e" /></div>
          <div>
            <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 15, color: "#f4f1ea" }}>Rent Book</div>
            <div style={{ fontSize: 11, color: "#8b93a1", display: "flex", alignItems: "center", gap: 6 }}>{activeTenants.length} units <LiveDot live={live} /></div>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          {properties.length > 1 ? (
            <select value={propertyId || ""} onChange={(e) => setPropertyId(e.target.value)} style={{
              width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(255,255,255,.14)",
              background: "rgba(255,255,255,.05)", color: "#f4f1ea", fontFamily: "'Space Grotesk',sans-serif",
              fontWeight: 600, fontSize: 13,
            }}>
              {properties.map((p) => <option key={p.id} value={p.id} style={{ color: "#1c2836" }}>{p.name}</option>)}
            </select>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 10px", borderRadius: 8, background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)" }}>
              <MapPin size={13} color="#b8892b" />
              <span style={{ fontSize: 12.5, color: "#d7dce3", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{activeProperty?.name || "—"}</span>
            </div>
          )}
        </div>
      </div>
      <nav style={{ padding: "14px 12px", flex: 1, overflowY: "auto" }}>
        {NAV.map((n) => {
          const on = view === n.id; const Icon = n.icon;
          return (
            <button key={n.id} onClick={() => go(n.id)} style={{
              ...S.navBtn, background: on ? "rgba(184,137,43,.16)" : "transparent",
              color: on ? "#f4d488" : "#aeb6c2", borderLeft: on ? "2px solid #b8892b" : "2px solid transparent",
            }}>
              <Icon size={17} /> {n.label}
            </button>
          );
        })}
      </nav>
      <div style={{ padding: "14px 16px", borderTop: "1px solid rgba(255,255,255,.08)" }}>
        <div style={{ fontSize: 11.5, color: "#8b93a1", marginBottom: 8, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {email} · {role}
        </div>
        <button onClick={() => authApi.signOut()} style={{ ...S.navBtn, color: "#aeb6c2", padding: "8px 10px" }}>
          <LogOut size={15} /> Sign out
        </button>
      </div>
    </>
  );

  return (
    <div style={{ ...S.page, flexDirection: isMobile ? "column" : "row" }}>
      {!isMobile && <aside style={S.sidebar}>{railInner}</aside>}

      {isMobile && (
        <header style={S.mtopbar}>
          <button onClick={() => setDrawerOpen(true)} style={S.hamburger} aria-label="Open menu"><Menu size={20} /></button>
          <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0, flex: 1 }}>
            <div style={S.brassPlaque}><Building2 size={16} color="#1a222e" /></div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 14, color: "#f4f1ea", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{NAV.find((n) => n.id === view)?.label}</div>
              <div style={{ fontSize: 10.5, color: "#8b93a1", display: "flex", alignItems: "center", gap: 5 }}>{activeProperty?.name || "Rent Book"} <LiveDot live={live} /></div>
            </div>
          </div>
          <MonthPicker month={month} options={monthOptions} onChange={setMonth} onShift={shiftMonth} compact />
        </header>
      )}

      {isMobile && drawerOpen && (
        <div style={S.drawerOverlay} onClick={() => setDrawerOpen(false)}>
          <aside style={S.drawer} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "flex-end", padding: "10px 10px 0" }}>
              <button onClick={() => setDrawerOpen(false)} style={{ ...S.iconBtn, color: "#aeb6c2" }} aria-label="Close menu"><X size={20} /></button>
            </div>
            {railInner}
          </aside>
        </div>
      )}

      <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
        {!isMobile && (
          <header style={S.topbar}>
            <div>
              <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 20, color: "#1c2836" }}>{NAV.find((n) => n.id === view)?.label}</div>
              <div style={{ fontSize: 12.5, color: "#8a8681", marginTop: 1 }}>{activeProperty?.name || "Rent roll"} · subsidized rent roll</div>
            </div>
            <MonthPicker month={month} options={monthOptions} onChange={setMonth} onShift={shiftMonth} />
          </header>
        )}

        <div style={{ flex: 1, overflow: "auto", padding: isMobile ? "16px 14px 88px" : "24px 28px 60px" }}>
          {loading ? (
            <div style={{ color: "#8a8681", fontFamily: "'Space Grotesk',sans-serif", padding: 40 }}>Loading the rent book…</div>
          ) : (
            <>
              {view === "overview" && <Overview roll={roll} monthLabel={monthLabel} leaseAlerts={leaseAlerts} go={setView} parking={visibleParking} parkingPaid={parkingPaid} monthExpenses={monthExpenses} />}
              {view === "collections" && <Collections roll={roll} monthLabel={monthLabel} setPay={setPay} parking={visibleParking} parkingRec={parkingPaid} parkingNotes={parkingNotes} setParkingReceived={setParkingReceived} setParkingNote={setParkingNote} />}
              {view === "ledger" && <Ledger tenants={activeTenants} terms={rentTerms} rawPayments={rawPayments} />}
              {view === "expenses" && <Expenses expenses={expenses} monthExpenses={monthExpenses} monthLabel={monthLabel} month={month} tenants={activeTenants} onAdd={addExpense} onRemove={removeExpense} />}
              {view === "tenants" && <Tenants tenants={tenants} onEdit={setEditTenant} onAdd={() => setEditTenant("new")} />}
              {view === "parking" && <Parking parking={parking} parkingRec={parkingPaid} monthLabel={monthLabel} setReceived={setParkingReceived} setActive={setParkingActive} tenants={activeTenants} propertyId={propertyId} onChanged={loadStatic} flash={flash} />}
              {view === "log" && <LogTab notes={buildingNotes} onAdd={(body) => addNote({ tenant_id: null, body })} onRemove={removeNote} />}
              {view === "summary" && <Summary tenants={activeTenants} allStatus={allStatus} allParkPaid={allParkPaid} parking={parking} expenses={expenses} onJump={(m) => { setMonth(m); setView("collections"); }} />}
              {view === "activity" && <Activity rows={audit} tenants={tenants} onRefresh={loadAudit} />}
            </>
          )}
        </div>
      </main>

      {editTenant && (
        <TenantModal
          tenant={editTenant === "new" ? null : editTenant}
          terms={modalTerms}
          tenantNotes={modalNotes}
          propertyId={propertyId}
          onClose={() => setEditTenant(null)}
          onSave={saveTenant}
          onDelete={deleteTenant}
          onArchive={archiveTenant}
          onAddTerm={addTerm}
          onRemoveTerm={removeTerm}
          onAddNote={(body, tid) => addNote({ tenant_id: tid, body })}
          onRemoveNote={removeNote}
          onParkingChanged={loadStatic}
          flash={flash}
        />
      )}

      {toast && (
        <div style={{
          position: "fixed", left: "50%", bottom: 24, transform: "translateX(-50%)", zIndex: 90,
          display: "flex", alignItems: "center", gap: 9, padding: "11px 16px", borderRadius: 10,
          background: toast.kind === "error" ? "#3a2320" : "#173a2a", color: toast.kind === "error" ? "#f3c0b8" : "#a6e0c2",
          border: `1px solid ${toast.kind === "error" ? "#7a3b32" : "#2c6146"}`, boxShadow: "0 10px 34px rgba(0,0,0,.28)",
          fontSize: 13.5, fontWeight: 500, maxWidth: "92vw",
        }}>
          {toast.kind === "error" ? <AlertTriangle size={16} /> : <Check size={16} />}
          {toast.text}
        </div>
      )}
    </div>
  );
}

/* Live-sync status pip — green + subtle glow when the realtime websocket is connected. */
function LiveDot({ live }) {
  return (
    <span title={live ? "Live sync on — changes from other devices appear instantly" : "Connecting live sync…"}
      style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: live ? "#12a06e" : "#8b93a1", boxShadow: live ? "0 0 0 3px rgba(18,160,110,.2)" : "none" }} />
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: live ? "#5fcf9e" : "#8b93a1" }}>{live ? "Live" : "…"}</span>
    </span>
  );
}

/* Month navigator — dropdown plus prev/next arrows that reach any month. */
function MonthPicker({ month, options, onChange, onShift, compact }) {
  const arrow = {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: compact ? 32 : 36, height: compact ? 34 : 38, borderRadius: 8,
    border: "1px solid #e2ddd0", background: "#faf8f3", color: "#5a5850", flexShrink: 0,
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <button onClick={() => onShift(-1)} style={arrow} aria-label="Previous month"><ChevronLeft size={16} /></button>
      <select value={month} onChange={(e) => onChange(e.target.value)} style={{ ...S.monthSelect, ...(compact ? { padding: "7px 8px", fontSize: 12.5 } : {}) }}>
        {options.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
      </select>
      <button onClick={() => onShift(1)} style={arrow} aria-label="Next month"><ChevronRight size={16} /></button>
    </div>
  );
}

/* ================= SUMMARY (by month / quarter / year) ================= */
function Summary({ tenants, allStatus, allParkPaid, parking, expenses, onJump }) {
  const isMobile = useIsMobile();
  const [grouping, setGrouping] = useState("month");

  // Scope the all-time data to this property's tenants / spots.
  const tenantIds = useMemo(() => new Set(tenants.map((t) => t.id)), [tenants]);
  const spotIds = useMemo(() => new Set(parking.map((p) => p.id)), [parking]);
  const scopedStatus = useMemo(() => allStatus.filter((s) => tenantIds.has(s.tenant_id)), [allStatus, tenantIds]);

  const rows = useMemo(() => {
    const acc = {}; // periodKey -> aggregates
    const bump = (mk) => {
      const pk = periodKeyFor(mk, grouping);
      return (acc[pk] = acc[pk] || { period: pk, expected: 0, collected: 0, parking: 0, expenses: 0, paid: 0, partial: 0, owed: 0, units: 0 });
    };
    // rent collected + status counts, per month
    scopedStatus.forEach((s) => {
      const a = bump(s.month);
      a.collected += +s.total || 0; a.units += 1;
      if (s.status === "paid") a.paid += 1; else if (s.status === "partial") a.partial += 1; else a.owed += 1;
    });
    // expected rent per month = lease rent for tenants inside their collection window
    const monthsSeen = new Set(scopedStatus.map((s) => s.month));
    monthsSeen.forEach((mk) => {
      const a = bump(mk);
      tenants.forEach((t) => { if (monthReached(t.lease_start, mk)) a.expected += +t.lease_rent || 0; });
    });
    // parking collected per month (actual received amount, this property's spots)
    allParkPaid.forEach((pp) => { if (spotIds.has(pp.spot_id)) bump(pp.month).parking += +pp.amount || 0; });
    // expenses per month
    expenses.forEach((e) => { const mk = (e.spent_on || "").slice(0, 7); if (mk) bump(mk).expenses += +e.amount || 0; });

    return Object.values(acc)
      .map((a) => ({ ...a, income: a.collected + a.parking, net: a.collected + a.parking - a.expenses, outstanding: Math.max(a.expected - a.collected, 0) }))
      .sort((x, y) => (x.period < y.period ? 1 : -1));
  }, [scopedStatus, tenants, allParkPaid, spotIds, expenses, grouping]);

  const tot = rows.reduce((s, r) => ({
    expected: s.expected + r.expected, collected: s.collected + r.collected, parking: s.parking + r.parking,
    expenses: s.expenses + r.expenses, income: s.income + r.income, net: s.net + r.net, outstanding: s.outstanding + r.outstanding,
  }), { expected: 0, collected: 0, parking: 0, expenses: 0, income: 0, net: 0, outstanding: 0 });

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 14, marginBottom: 18 }}>
        <BigStat label="Rent collected · all time" value={money(tot.collected)} sub={`${rows.length} ${grouping === "month" ? "months" : grouping === "quarter" ? "quarters" : "years"}`} accent="#0f7a54" />
        <BigStat label="Parking collected" value={money(tot.parking)} sub="all time" accent="#3a6ea5" />
        <BigStat label="Expenses" value={money(tot.expenses)} sub="all time" accent="#a83232" />
        <BigStat label="Net operating" value={money(tot.net)} sub="income − expenses" accent={tot.net >= 0 ? "#0f7a54" : "#a83232"} />
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {[["month", "By month"], ["quarter", "By quarter"], ["year", "By year"]].map(([k, lbl]) => (
          <button key={k} onClick={() => setGrouping(k)} style={{
            ...S.pill, cursor: "pointer",
            background: grouping === k ? "#161f2b" : "#f3f0e9", color: grouping === k ? "#f4d488" : "#8a8681",
            border: grouping === k ? "none" : "1px solid #ddd7cb",
          }}>{lbl}</button>
        ))}
      </div>

      <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "13px 18px", borderBottom: "1px solid #eee9df", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={S.cardTitle}>Collections summary</div>
          <div style={{ fontSize: 12, color: "#8a8681" }}>{rows.length} periods</div>
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "#8a8681", fontSize: 13 }}>No collection data yet.</div>
        ) : isMobile ? (
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            {rows.map((r) => (
              <div key={r.period} onClick={grouping === "month" ? () => onJump(r.period) : undefined}
                style={{ border: "1px solid #f0ece3", borderRadius: 10, padding: 12, cursor: grouping === "month" ? "pointer" : "default" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 14, color: "#1c2836" }}>{periodLabelFor(r.period, grouping)}</span>
                  <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 700, fontSize: 15, color: r.net >= 0 ? "#0f7a54" : "#a83232" }}>{money(r.net)}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 12.5 }}>
                  <SumLine label="Rent + parking" v={r.income} />
                  <SumLine label="Expenses" v={-r.expenses} />
                  <SumLine label="Expected" v={r.expected} dim />
                  <SumLine label="Outstanding" v={r.outstanding} warn={r.outstanding > 0.5} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
              <thead>
                <tr>{["Period", "Expected", "Rent collected", "Parking", "Outstanding", "Expenses", "Net operating"].map((h, i) => (
                  <th key={h} style={{ ...S.th, textAlign: i === 0 ? "left" : "right" }}>{h}</th>))}</tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.period} onClick={grouping === "month" ? () => onJump(r.period) : undefined}
                    style={{ borderBottom: "1px solid #f2eee5", cursor: grouping === "month" ? "pointer" : "default" }}>
                    <td style={{ ...S.td, fontWeight: 600 }}>{periodLabelFor(r.period, grouping)}</td>
                    <td style={{ ...S.td, textAlign: "right" }}><Money v={r.expected} dim /></td>
                    <td style={{ ...S.td, textAlign: "right" }}><Money v={r.collected} bold /></td>
                    <td style={{ ...S.td, textAlign: "right" }}><Money v={r.parking} /></td>
                    <td style={{ ...S.td, textAlign: "right" }}><OutMoney v={r.outstanding} /></td>
                    <td style={{ ...S.td, textAlign: "right" }}><Money v={r.expenses} /></td>
                    <td style={{ ...S.td, textAlign: "right" }}><span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 600, color: r.net >= 0 ? "#0f7a54" : "#a83232" }}>{money(r.net)}</span></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: "#faf8f3" }}>
                  <td style={{ ...S.td, fontWeight: 700 }}>Total</td>
                  <td style={{ ...S.td, textAlign: "right" }}><Money v={tot.expected} bold /></td>
                  <td style={{ ...S.td, textAlign: "right" }}><Money v={tot.collected} bold /></td>
                  <td style={{ ...S.td, textAlign: "right" }}><Money v={tot.parking} bold /></td>
                  <td style={{ ...S.td, textAlign: "right" }}><OutMoney v={tot.outstanding} /></td>
                  <td style={{ ...S.td, textAlign: "right" }}><Money v={tot.expenses} bold /></td>
                  <td style={{ ...S.td, textAlign: "right" }}><span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 700, color: tot.net >= 0 ? "#0f7a54" : "#a83232" }}>{money(tot.net)}</span></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
      <div style={{ fontSize: 12, color: "#8a8681", marginTop: 10 }}>
        Net operating = rent + parking collected − expenses. {grouping === "month" && "Tap a month to open it in Collections."}
      </div>
    </div>
  );
}
function SumLine({ label, v, dim, warn }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
      <span style={{ color: "#8a8681" }}>{label}</span>
      <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: warn ? 700 : 600, color: warn ? "#a83232" : dim ? "#9a958c" : "#1c2836" }}>{money(v)}</span>
    </div>
  );
}

/* Outstanding balance — bold red when there's a shortfall, muted when clear. */
function OutMoney({ v, size = 14 }) {
  const owed = v > 0.5;
  return (
    <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: owed ? 700 : 500, fontVariantNumeric: "tabular-nums", color: owed ? "#a83232" : "#9a958c" }}>
      {money(v)}
    </span>
  );
}

/* ================= ACTIVITY (change log by user) ================= */
const auditFmt = (v) => {
  if (v === null || v === undefined || v === "") return "—";
  if (v === true) return "yes"; if (v === false) return "no";
  if (typeof v === "number" || (/^\d+(\.\d+)?$/.test(v))) return money(v);
  return String(v);
};
function timeAgo(iso) {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function Activity({ rows, tenants, onRefresh }) {
  const [q, setQ] = useState("");
  const [type, setType] = useState("all");
  const tmap = useMemo(() => { const m = {}; tenants.forEach((t) => { m[t.id] = t; }); return m; }, [tenants]);

  const describe = (r) => {
    const d = r.new_data || r.old_data || {};
    const verb = r.action === "INSERT" ? "added" : r.action === "DELETE" ? "removed" : "updated";
    let target = r.table_name, detail = "";
    if (r.table_name === "payments") {
      const t = tmap[d.tenant_id];
      target = `${t ? `${t.unit} · ${t.name}` : "Payment"} — ${d.month || ""}`;
      if (r.action === "UPDATE" && r.old_data && r.new_data) {
        detail = ["govt", "portion", "assistance", "check_num", "bank_confirm", "notes"]
          .filter((f) => String(r.old_data[f] ?? "") !== String(r.new_data[f] ?? ""))
          .map((f) => `${f}: ${auditFmt(r.old_data[f])} → ${auditFmt(r.new_data[f])}`).join(" · ");
      }
    } else if (r.table_name === "tenants") { target = d.name ? `${d.unit || ""} · ${d.name}` : "Tenant"; }
    else if (r.table_name === "parking_spots") { const t = tmap[d.tenant_id]; target = `Parking ${d.spot || ""}${t ? ` · ${t.name}` : ""}`; }
    else if (r.table_name === "parking_payments") { target = `Parking payment — ${d.month || ""}`; }
    else if (r.table_name === "rent_terms") { const t = tmap[d.tenant_id]; target = `Rent term${t ? ` · ${t.name}` : ""}`; }
    else if (r.table_name === "expenses") { target = `Expense${d.vendor ? ` · ${d.vendor}` : ""}${d.amount ? ` (${money(d.amount)})` : ""}`; }
    else if (r.table_name === "notes") { target = "Note"; }
    else if (r.table_name === "properties") { target = `Property ${d.name || ""}`; }
    return { verb, target, detail };
  };

  const types = ["all", "payments", "tenants", "parking_spots", "expenses", "rent_terms", "notes"];
  const filtered = rows.filter((r) => (type === "all" || r.table_name === type) &&
    (!q || JSON.stringify(r).toLowerCase().includes(q.toLowerCase())));
  const color = (a) => a === "INSERT" ? "#0f7a54" : a === "DELETE" ? "#a83232" : "#8a6a1e";

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ position: "relative", flex: 1, minWidth: 200, maxWidth: 340 }}>
          <Search size={15} color="#a8a294" style={{ position: "absolute", left: 12, top: 11 }} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search changes, tenants, users"
            style={{ ...S.cellInput, width: "100%", padding: "9px 12px 9px 34px", fontFamily: "'Inter',sans-serif" }} />
        </div>
        <select value={type} onChange={(e) => setType(e.target.value)} style={S.monthSelect}>
          {types.map((t) => <option key={t} value={t}>{t === "all" ? "All records" : t.replace("_", " ")}</option>)}
        </select>
        <button onClick={onRefresh} style={S.ghostBtn}>Refresh</button>
      </div>
      <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "13px 18px", borderBottom: "1px solid #eee9df", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={S.cardTitle}>Change log</div>
          <div style={{ fontSize: 12, color: "#8a8681" }}>{filtered.length} of {rows.length} · newest first</div>
        </div>
        {filtered.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "#8a8681", fontSize: 13 }}>No matching activity yet. Every create, edit, and delete is recorded here.</div>
        ) : filtered.map((r) => {
          const { verb, target, detail } = describe(r);
          return (
            <div key={r.id} style={{ display: "flex", gap: 12, padding: "12px 18px", borderBottom: "1px solid #f2eee5", alignItems: "flex-start" }}>
              <span style={{ marginTop: 3, width: 8, height: 8, borderRadius: "50%", background: color(r.action), flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, color: "#1c2836" }}>
                  <b style={{ fontWeight: 600 }}>{r.actor_email || "System"}</b>
                  <span style={{ color: "#6b6b66" }}> {verb} </span>
                  <b style={{ fontWeight: 600 }}>{target}</b>
                </div>
                {detail && <div style={{ fontSize: 12, color: "#8a6a1e", fontFamily: "'IBM Plex Mono',monospace", marginTop: 3, wordBreak: "break-word" }}>{detail}</div>}
              </div>
              <div style={{ fontSize: 11.5, color: "#a29d92", whiteSpace: "nowrap", flexShrink: 0 }}>{timeAgo(r.at)}</div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 12, color: "#8a8681", marginTop: 10 }}>
        This log is append-only — every change is kept, and nothing here can be edited or deleted. It doubles as the version history for each entry.
      </div>
    </div>
  );
}

/* ================= OVERVIEW ================= */
function Overview({ roll, monthLabel, leaseAlerts, go, parking, parkingPaid, monthExpenses }) {
  const isMobile = useIsMobile();
  const rate = roll.expected ? Math.round((roll.collected / roll.expected) * 100) : 0;
  const owedRows = roll.rows.filter((x) => x.r.status !== "paid");
  const n = Math.max(roll.rows.length, 1);

  const income = {};
  roll.rows.forEach(({ t, r }) => {
    if (r.govt > 0) income[t.program || "Government"] = (income[t.program || "Government"] || 0) + r.govt;
    if (r.assistance > 0) income["Assistance / supplements"] = (income["Assistance / supplements"] || 0) + r.assistance;
    if (r.portion > 0) income["Tenant paid"] = (income["Tenant paid"] || 0) + r.portion;
    if (r.extra > 0) income["Extra / other"] = (income["Extra / other"] || 0) + r.extra;
  });
  const parkingCollected = parking.reduce((s, p) => s + (+parkingPaid[p.id] || 0), 0);
  if (parkingCollected > 0) income["Parking"] = parkingCollected;
  const incomeRows = Object.entries(income).sort((a, b) => b[1] - a[1]);
  const totalIncome = incomeRows.reduce((s, [, v]) => s + v, 0);
  const totalExpenses = monthExpenses.reduce((s, e) => s + +e.amount, 0);
  const net = totalIncome - totalExpenses;
  const SRC_COLORS = ["#147d5a", "#b8892b", "#3a6ea5", "#9a6511", "#7a5c9e", "#5a6472"];

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 14, marginBottom: 22 }}>
        <BigStat label={`Expected · ${monthLabel}`} value={money(roll.expected)} sub={`${roll.rows.length} active units`} accent="#1c2836" />
        <BigStat label="Collected" value={money(roll.collected)} sub={`${rate}% of rent roll`} accent="#0f7a54" />
        <BigStat label="Parking income" value={money(parkingCollected)} sub={`${parking.filter((p) => (+parkingPaid[p.id] || 0) > 0).length} of ${parking.length} spots paid`} accent="#3a6ea5" />
        <BigStat label="Outstanding" value={money(roll.outstanding)} sub={`${roll.owedCt + roll.partialCt} units short`} accent={roll.outstanding > 0.5 ? "#a83232" : "#0f7a54"} />
        <BigStat label="Net operating" value={money(net)} sub={`${money(totalIncome)} in − ${money(totalExpenses)} out`} accent={net >= 0 ? "#0f7a54" : "#a83232"} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 16, marginBottom: 16, alignItems: "start" }}>
        <div style={S.card}>
          <div style={{ ...S.cardTitle, marginBottom: 14 }}>Income by source · {monthLabel}</div>
          {incomeRows.length === 0 ? (
            <div style={{ color: "#8a8681", fontSize: 13, padding: "8px 0" }}>No income logged yet this month.</div>
          ) : incomeRows.map(([label, val], i) => (
            <div key={label} style={{ marginBottom: 11 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
                <span style={{ color: "#4a4842", fontWeight: 600 }}>{label}</span>
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", color: "#1c2836", fontWeight: 600 }}>{money(val)}</span>
              </div>
              <div style={{ height: 7, borderRadius: 4, background: "#eee9df", overflow: "hidden" }}>
                <div style={{ width: `${(val / totalIncome) * 100}%`, height: "100%", background: SRC_COLORS[i % SRC_COLORS.length] }} />
              </div>
            </div>
          ))}
          {incomeRows.length > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 14, paddingTop: 12, borderTop: "1px solid #f0ece3", fontSize: 13, fontWeight: 700 }}>
              <span>Total income</span><Money v={totalIncome} bold />
            </div>
          )}
        </div>

        <div style={S.card}>
          <div style={{ ...S.cardTitle, marginBottom: 12, display: "flex", justifyContent: "space-between" }}>
            <span>Month P&amp;L</span>
            <button onClick={() => go("expenses")} style={S.linkBtn}>Expenses <ChevronRight size={13} /></button>
          </div>
          <PLRow label="Rent + parking collected" v={totalIncome} />
          <PLRow label="Expenses" v={-totalExpenses} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, paddingTop: 12, borderTop: "2px solid #ece7dc" }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>Net operating</span>
            <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 700, fontSize: 18, color: net >= 0 ? "#0f7a54" : "#a83232" }}>{money(net)}</span>
          </div>
          <div style={{ fontSize: 11.5, color: "#a29d92", marginTop: 8 }}>Based on money actually collected and expenses logged for {monthLabel}.</div>
        </div>
      </div>

      <div style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={S.cardTitle}>Collection progress</div>
          <div style={{ display: "flex", gap: 14, fontSize: 12, color: "#6b6b66" }}>
            <Legend dot="#12a06e" label={`${roll.paidCt} paid`} />
            <Legend dot="#e0a326" label={`${roll.partialCt} partial`} />
            <Legend dot="#d24b4b" label={`${roll.owedCt} owed`} />
          </div>
        </div>
        <div style={{ display: "flex", height: 14, borderRadius: 7, overflow: "hidden", background: "#eee9df" }}>
          <div style={{ width: `${(roll.paidCt / n) * 100}%`, background: "#12a06e" }} />
          <div style={{ width: `${(roll.partialCt / n) * 100}%`, background: "#e0a326" }} />
          <div style={{ width: `${(roll.owedCt / n) * 100}%`, background: "#d24b4b" }} />
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1.4fr 1fr", gap: 16, marginTop: 16, alignItems: "start" }}>
        <div style={S.card}>
          <div style={{ ...S.cardTitle, marginBottom: 12, display: "flex", justifyContent: "space-between" }}>
            <span>Needs attention</span>
            <button onClick={() => go("collections")} style={S.linkBtn}>Open collections <ChevronRight size={13} /></button>
          </div>
          {owedRows.length === 0 ? (
            <div style={{ padding: "20px 0", textAlign: "center", color: "#0f7a54", fontSize: 13.5, fontWeight: 600 }}>
              <Check size={16} style={{ verticalAlign: "-2px" }} /> Every unit is fully collected for {monthLabel}.
            </div>
          ) : owedRows.map(({ t, r }) => (
            <div key={t.id} style={S.attnRow}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <UnitChip unit={t.unit} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5, color: "#1c2836", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</div>
                  <div style={{ fontSize: 11.5, color: "#8a8681" }}>{t.program}</div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 10.5, color: "#8a8681", textTransform: "uppercase", letterSpacing: ".04em" }}>Short</div>
                  <Money v={r.variance || -r.rent} size={13} bold />
                </div>
                <Stamp status={r.status} />
              </div>
            </div>
          ))}
        </div>

        <div style={S.card}>
          <div style={{ ...S.cardTitle, marginBottom: 12 }}>Lease renewals</div>
          {leaseAlerts.length === 0 ? (
            <div style={{ color: "#8a8681", fontSize: 13, padding: "8px 0" }}>No leases ending in the next 120 days (for units with dates on file).</div>
          ) : leaseAlerts.map(({ t, end, days }) => (
            <div key={t.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: "1px solid #f0ece3" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <UnitChip unit={t.unit} />
                <span style={{ fontSize: 13, fontWeight: 600, color: "#1c2836" }}>{t.name}</span>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: days < 0 ? "#a83232" : days <= 45 ? "#9a6511" : "#1c2836", fontFamily: "'IBM Plex Mono',monospace" }}>
                  {days < 0 ? `${Math.abs(days)}d overdue` : `${days}d`}
                </div>
                <div style={{ fontSize: 11, color: "#8a8681" }}>{end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PLRow({ label, v }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0" }}>
      <span style={{ fontSize: 13, color: "#4a4842" }}>{label}</span>
      <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13.5, fontWeight: 600, color: v < 0 ? "#a83232" : "#1c2836" }}>{money(v)}</span>
    </div>
  );
}

/* ================= COLLECTIONS ================= */
function Collections({ roll, monthLabel, setPay, parking = [], parkingRec = {}, parkingNotes = {}, setParkingReceived, setParkingNote }) {
  const isMobile = useIsMobile();
  return (
    <div>
      <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", justifyContent: "space-between", alignItems: isMobile ? "flex-start" : "center", gap: isMobile ? 6 : 0, padding: "14px 18px", borderBottom: "1px solid #eee9df" }}>
          <div style={S.cardTitle}>Reconciliation · {monthLabel}</div>
          <div style={{ display: "flex", gap: 20, fontFamily: "'IBM Plex Mono',monospace", fontSize: 12.5 }}>
            <span style={{ color: "#8a8681" }}>Collected <b style={{ color: "#0f7a54" }}>{money(roll.collected)}</b></span>
            <span style={{ color: "#8a8681" }}>Outstanding <b style={{ color: roll.outstanding > 0.5 ? "#a83232" : "#0f7a54" }}>{money(roll.outstanding)}</b></span>
          </div>
        </div>
        {isMobile ? (
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            {roll.rows.map(({ t, r, pay }) => <CollectCard key={t.id} t={t} r={r} pay={pay} setPay={setPay} />)}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 4px 2px", borderTop: "2px solid #ece7dc", fontWeight: 700, fontSize: 13.5 }}>
              <span>Totals · {roll.rows.length} units</span>
              <Money v={roll.collected} bold size={15} />
            </div>
          </div>
        ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1140 }}>
            <thead>
              <tr>
                {["Unit", "Tenant", "Lease rent", "Govt (HAP)", "Tenant portion", "Assistance", "Extra", "Check #", "Collected", "Variance", "Status", "Notes"].map((h, i) => (
                  <th key={h} style={{ ...S.th, textAlign: i >= 2 && i <= 9 ? "right" : "left" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {roll.rows.map(({ t, r, pay }) => (
                <tr key={t.id} style={{ borderBottom: "1px solid #f2eee5" }}>
                  <td style={S.td}><UnitChip unit={t.unit} /></td>
                  <td style={S.td}>
                    <div style={{ fontWeight: 600, fontSize: 13.5, color: "#1c2836" }}>{t.name}</div>
                    <div style={{ fontSize: 11, color: "#8a8681" }}>{t.program}</div>
                  </td>
                  <td style={{ ...S.td, textAlign: "right" }}><Money v={r.rent} dim /></td>
                  <td style={{ ...S.td, textAlign: "right" }}><NumCell value={pay.govt} onCommit={(v) => setPay(t.id, "govt", v)} /></td>
                  <td style={{ ...S.td, textAlign: "right" }}><NumCell value={pay.portion} onCommit={(v) => setPay(t.id, "portion", v)} /></td>
                  <td style={{ ...S.td, textAlign: "right" }}><NumCell value={pay.assistance} onCommit={(v) => setPay(t.id, "assistance", v)} /></td>
                  <td style={{ ...S.td, textAlign: "right" }}><NumCell value={pay.extra} onCommit={(v) => setPay(t.id, "extra", v)} /></td>
                  <td style={{ ...S.td, textAlign: "right" }}>
                    <TextCell value={pay.check_num} onCommit={(v) => setPay(t.id, "check_num", v)} />
                  </td>
                  <td style={{ ...S.td, textAlign: "right" }}><Money v={r.total} bold /></td>
                  <td style={{ ...S.td, textAlign: "right" }}><Variance v={r.variance} /></td>
                  <td style={{ ...S.td, textAlign: "right" }}><Stamp status={r.status} /></td>
                  <td style={{ ...S.td, minWidth: 190 }}>
                    <RowNote value={pay.notes} onCommit={(v) => setPay(t.id, "notes", v)} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: "#faf8f3" }}>
                <td style={{ ...S.td, fontWeight: 700 }} colSpan={2}>Totals · {roll.rows.length} units</td>
                <td style={{ ...S.td, textAlign: "right" }}><Money v={roll.expected} bold /></td>
                <td style={{ ...S.td, textAlign: "right" }}><Money v={roll.govtTotal} bold /></td>
                <td style={{ ...S.td, textAlign: "right" }}><Money v={roll.portionTotal} bold /></td>
                <td style={{ ...S.td, textAlign: "right" }}><Money v={roll.assistanceTotal} bold /></td>
                <td style={{ ...S.td, textAlign: "right" }}><Money v={roll.extraTotal} bold /></td>
                <td style={S.td}></td>
                <td style={{ ...S.td, textAlign: "right" }}><Money v={roll.collected} bold /></td>
                <td style={{ ...S.td, textAlign: "right" }}><Variance v={-roll.outstanding} /></td>
                <td style={S.td}></td>
                <td style={S.td}></td>
              </tr>
            </tfoot>
          </table>
        </div>
        )}
      </div>
      <div style={{ fontSize: 12, color: "#8a8681", marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
        <Pencil size={12} /> Set each month's govt / tenant / assistance split and notes here — the database recomputes the total, variance, and status, and it syncs to everyone on the account.
      </div>

      {parking.length > 0 && setParkingReceived && (
        <CollectionsParking parking={parking} parkingRec={parkingRec} parkingNotes={parkingNotes} setParkingReceived={setParkingReceived} setParkingNote={setParkingNote} monthLabel={monthLabel} />
      )}
    </div>
  );
}

/* Parking reconciliation inside Collections — enter the amount received per spot. */
function CollectionsParking({ parking, parkingRec, parkingNotes = {}, setParkingReceived, setParkingNote, monthLabel }) {
  const expected = parking.reduce((s, p) => s + (+p.amount || 0), 0);
  const collected = parking.reduce((s, p) => s + (+parkingRec[p.id] || 0), 0);
  return (
    <div style={{ ...S.card, padding: 0, overflow: "hidden", marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px", borderBottom: "1px solid #eee9df", gap: 12, flexWrap: "wrap" }}>
        <div style={{ ...S.cardTitle, display: "flex", alignItems: "center", gap: 8 }}><Car size={16} color="#5a6472" /> Parking · {monthLabel}</div>
        <div style={{ display: "flex", gap: 20, fontFamily: "'IBM Plex Mono',monospace", fontSize: 12.5 }}>
          <span style={{ color: "#8a8681" }}>Received <b style={{ color: "#0f7a54" }}>{money(collected)}</b></span>
          <span style={{ color: "#8a8681" }}>Expected <b style={{ color: "#1c2836" }}>{money(expected)}</b></span>
        </div>
      </div>
      {parking.map((p, i) => (
        <ParkingRow key={p.id} p={p} received={+parkingRec[p.id] || 0} onCommit={(v) => setParkingReceived(p.id, v)}
          note={parkingNotes[p.id] || ""} onCommitNote={setParkingNote ? (v) => setParkingNote(p.id, v) : undefined}
          last={i === parking.length - 1} />
      ))}
    </div>
  );
}

/* Mobile reconciliation card — one tenant, editable, with the figures that were
   off-screen in the desktop table (collected, variance, status) up top. */
function CollectCard({ t, r, pay, setPay }) {
  return (
    <div style={{ border: "1px solid #f0ece3", borderRadius: 10, padding: 12, background: "#fff" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
        <div style={{ display: "flex", gap: 9, alignItems: "center", minWidth: 0 }}>
          <UnitChip unit={t.unit} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: "#1c2836", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</div>
            <div style={{ fontSize: 11.5, color: "#8a8681" }}>{t.program}</div>
          </div>
        </div>
        <Stamp status={r.status} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, margin: "12px 0", padding: "10px 0", borderTop: "1px solid #f4f0e8", borderBottom: "1px solid #f4f0e8" }}>
        <MiniFig label="Lease"><Money v={r.rent} dim size={13} /></MiniFig>
        <MiniFig label="Collected"><Money v={r.total} bold size={13} /></MiniFig>
        <MiniFig label="Variance"><Variance v={r.variance} /></MiniFig>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Labeled label="Govt (HAP)"><NumCell value={pay.govt} onCommit={(v) => setPay(t.id, "govt", v)} full /></Labeled>
        <Labeled label="Tenant portion"><NumCell value={pay.portion} onCommit={(v) => setPay(t.id, "portion", v)} full /></Labeled>
        <Labeled label="Assistance"><NumCell value={pay.assistance} onCommit={(v) => setPay(t.id, "assistance", v)} full /></Labeled>
        <Labeled label="Extra"><NumCell value={pay.extra} onCommit={(v) => setPay(t.id, "extra", v)} full /></Labeled>
        <Labeled label="Check #"><TextCell value={pay.check_num} onCommit={(v) => setPay(t.id, "check_num", v)} full /></Labeled>
      </div>
      <div style={{ marginTop: 10 }}>
        <Labeled label="Notes"><NoteCell value={pay.notes} onCommit={(v) => setPay(t.id, "notes", v)} /></Labeled>
      </div>
    </div>
  );
}

/* Free-text note for a tenant's month — commits on blur, like the other cells. */
function NoteCell({ value, onCommit }) {
  const [v, setV] = useState(value ?? "");
  useEffect(() => { setV(value ?? ""); }, [value]);
  return (
    <textarea value={v} onChange={(e) => setV(e.target.value)} onBlur={() => onCommit(v)} rows={2}
      placeholder="Comments — e.g. shelter paid $283, portion promised by month-end"
      style={{ ...S.field, width: "100%", resize: "vertical", fontFamily: "'Inter',sans-serif", lineHeight: 1.4, fontSize: 13.5 }} />
  );
}
/* Single-line note for the desktop reconciliation table. */
function RowNote({ value, onCommit }) {
  const [v, setV] = useState(value ?? "");
  useEffect(() => { setV(value ?? ""); }, [value]);
  return (
    <input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => onCommit(v)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      placeholder="Add a comment…"
      style={{ ...S.cellInput, width: "100%", minWidth: 170, textAlign: "left", fontFamily: "'Inter',sans-serif", fontSize: 12.5 }} />
  );
}

function NumCell({ value, onCommit, full }) {
  const [v, setV] = useState(value ?? "");
  useEffect(() => { setV(value ?? ""); }, [value]);
  return (
    <input value={v} onChange={(e) => setV(e.target.value)}
      onBlur={() => onCommit(v === "" ? 0 : parseFloat(v) || 0)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      inputMode="decimal" placeholder="0.00"
      style={{ ...S.cellInput, width: full ? "100%" : 84, textAlign: full ? "left" : "right", fontSize: full ? 16 : 13 }} />
  );
}
function TextCell({ value, onCommit, full }) {
  const [v, setV] = useState(value ?? "");
  useEffect(() => { setV(value ?? ""); }, [value]);
  return (
    <input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => onCommit(v)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      placeholder="—"
      style={{ ...S.cellInput, width: full ? "100%" : 92, textAlign: full ? "left" : "right", fontSize: full ? 16 : 12 }} />
  );
}

/* Small labeled field + centered figure used by the mobile card variants. */
function Labeled({ label, children }) {
  return (
    <label style={{ display: "block" }}>
      <div style={{ fontSize: 10.5, color: "#8a8681", fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: ".03em" }}>{label}</div>
      {children}
    </label>
  );
}
function MiniFig({ label, children }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 10, color: "#a8a294", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 3 }}>{label}</div>
      {children}
    </div>
  );
}

/* ================= ARREARS LEDGER ================= */
function Bal({ v, size = 13 }) {
  if (Math.abs(v) < 0.5) return <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: size, color: "#9a958c" }}>—</span>;
  const owed = v > 0;
  return (
    <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 600, fontSize: size, color: owed ? "#a83232" : "#0f7a54" }}>
      {owed ? money(v) : `(${money(Math.abs(v))})`}
    </span>
  );
}

function Ledger({ tenants, terms, rawPayments }) {
  const isMobile = useIsMobile();
  const rows = useMemo(() => buildLedger(tenants, terms, rawPayments, CURRENT_MONTH), [tenants, terms, rawPayments]);
  const [open, setOpen] = useState(null);
  const tenantArrears = rows.reduce((s, r) => s + Math.max(r.tenantBal, 0), 0);
  const govtArrears = rows.reduce((s, r) => s + Math.max(r.govtBal, 0), 0);
  const netOutstanding = rows.reduce((s, r) => s + r.totalBal, 0);

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 14, marginBottom: 18 }}>
        <BigStat label="Tenant arrears" value={money(tenantArrears)} sub="owed by tenants" accent={tenantArrears > 0.5 ? "#a83232" : "#0f7a54"} />
        <BigStat label="Government behind" value={money(govtArrears)} sub="delayed HAP / FHEPS" accent={govtArrears > 0.5 ? "#a83232" : "#0f7a54"} />
        <BigStat label="Net outstanding" value={money(netOutstanding)} sub="after any credits" accent={netOutstanding > 0.5 ? "#a83232" : "#0f7a54"} />
      </div>

      <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid #eee9df", display: "flex", flexDirection: isMobile ? "column" : "row", gap: isMobile ? 4 : 0, justifyContent: "space-between", alignItems: isMobile ? "flex-start" : "center" }}>
          <div style={S.cardTitle}>Balances by tenant</div>
          <div style={{ fontSize: 12, color: "#8a8681" }}>Red = owed to you · (green) = credit / overpaid</div>
        </div>
        {isMobile ? (
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            {rows.map((row) => <LedgerCard key={row.t.id} row={row} isOpen={open === row.t.id} onToggle={() => setOpen(open === row.t.id ? null : row.t.id)} />)}
          </div>
        ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
            <thead>
              <tr>
                <th style={{ ...S.th, width: 34 }}></th>
                <th style={S.th}>Unit / Tenant</th>
                <th style={{ ...S.th, textAlign: "right" }}>Govt balance</th>
                <th style={{ ...S.th, textAlign: "right" }}>Tenant balance</th>
                <th style={{ ...S.th, textAlign: "right" }}>Total owed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ t, govtBal, tenantBal, totalBal, detail }) => {
                const isOpen = open === t.id;
                return (
                  <React.Fragment key={t.id}>
                    <tr onClick={() => setOpen(isOpen ? null : t.id)} style={{ borderBottom: "1px solid #f2eee5", cursor: "pointer", background: isOpen ? "#faf8f3" : "transparent" }}>
                      <td style={{ ...S.td, textAlign: "center", color: "#a8a294" }}>{isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</td>
                      <td style={S.td}>
                        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                          <UnitChip unit={t.unit} />
                          <div>
                            <div style={{ fontWeight: 600, fontSize: 13.5, color: "#1c2836" }}>{t.name}</div>
                            <div style={{ fontSize: 11, color: "#8a8681" }}>{t.program}</div>
                          </div>
                        </div>
                      </td>
                      <td style={{ ...S.td, textAlign: "right" }}><Bal v={govtBal} /></td>
                      <td style={{ ...S.td, textAlign: "right" }}><Bal v={tenantBal} /></td>
                      <td style={{ ...S.td, textAlign: "right" }}><Bal v={totalBal} size={14} /></td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={5} style={{ padding: 0, background: "#fbfaf6", borderBottom: "1px solid #eee9df" }}>
                          <LedgerDetail detail={detail} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        )}
      </div>
      <div style={{ fontSize: 12, color: "#8a8681", marginTop: 10 }}>
        Balances carry forward from the first month you logged. Govt and tenant shortfalls are tracked separately, so you know whether to chase the agency or the tenant.
      </div>
    </div>
  );
}

/* Mobile balance card — tap to expand a compact per-month running balance. */
function LedgerCard({ row, isOpen, onToggle }) {
  const { t, govtBal, tenantBal, totalBal, detail } = row;
  return (
    <div style={{ border: "1px solid #f0ece3", borderRadius: 10, overflow: "hidden", background: "#fff" }}>
      <div onClick={onToggle} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: 12, cursor: "pointer" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
          <span style={{ color: "#a8a294", flexShrink: 0 }}>{isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
          <UnitChip unit={t.unit} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13.5, color: "#1c2836", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</div>
            <div style={{ fontSize: 11, color: "#8a8681" }}>{t.program}</div>
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: 10, color: "#a8a294", textTransform: "uppercase", letterSpacing: ".04em" }}>Total owed</div>
          <Bal v={totalBal} size={14} />
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, padding: "0 12px 12px" }}>
        <MiniFig label="Govt balance"><Bal v={govtBal} /></MiniFig>
        <MiniFig label="Tenant balance"><Bal v={tenantBal} /></MiniFig>
      </div>
      {isOpen && (
        detail.length === 0 ? (
          <div style={{ padding: "10px 12px", borderTop: "1px solid #eee9df", background: "#fbfaf6", fontSize: 12.5, color: "#8a8681" }}>No months due yet for this tenant.</div>
        ) : (
          <div style={{ borderTop: "1px solid #eee9df", background: "#fbfaf6", padding: "8px 12px" }}>
            {detail.map((d) => (
              <div key={d.month} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", fontSize: 12 }}>
                <span style={{ fontWeight: 600, color: "#5a5850" }}>{d.label}</span>
                <span style={{ display: "flex", gap: 14 }}>
                  <span style={{ color: "#8a8681" }}>Govt <Bal v={d.govtBal} size={12} /></span>
                  <span style={{ color: "#8a8681" }}>Tenant <Bal v={d.tenantBal} size={12} /></span>
                </span>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

function LedgerDetail({ detail }) {
  if (!detail.length) return <div style={{ padding: 16, fontSize: 12.5, color: "#8a8681" }}>No months due yet for this tenant.</div>;
  return (
    <div style={{ overflowX: "auto", padding: "6px 0" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
        <thead>
          <tr>
            {["Month", "Govt exp", "Govt in", "Govt Δ", "Tenant exp", "Tenant in", "Tenant Δ", "Govt bal", "Tenant bal"].map((h, i) => (
              <th key={h} style={{ ...S.th, background: "transparent", textAlign: i === 0 ? "left" : "right", fontSize: 10, padding: "7px 12px" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {detail.map((d) => (
            <tr key={d.month} style={{ borderBottom: "1px solid #f2eee5" }}>
              <td style={{ ...S.td, padding: "7px 12px", fontWeight: 600, fontSize: 12.5 }}>{d.label}</td>
              <td style={{ ...S.td, padding: "7px 12px", textAlign: "right" }}><Money v={d.govtExpected} size={12} dim /></td>
              <td style={{ ...S.td, padding: "7px 12px", textAlign: "right" }}><Money v={d.govtRec} size={12} /></td>
              <td style={{ ...S.td, padding: "7px 12px", textAlign: "right" }}><Bal v={d.govtShort} size={12} /></td>
              <td style={{ ...S.td, padding: "7px 12px", textAlign: "right" }}><Money v={d.tenantExpected} size={12} dim /></td>
              <td style={{ ...S.td, padding: "7px 12px", textAlign: "right" }}><Money v={d.tenRec} size={12} /></td>
              <td style={{ ...S.td, padding: "7px 12px", textAlign: "right" }}><Bal v={d.tenShort} size={12} /></td>
              <td style={{ ...S.td, padding: "7px 12px", textAlign: "right" }}><Bal v={d.govtBal} size={12} /></td>
              <td style={{ ...S.td, padding: "7px 12px", textAlign: "right" }}><Bal v={d.tenantBal} size={12} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ================= EXPENSES ================= */
function Expenses({ expenses, monthExpenses, monthLabel, month, tenants, onAdd, onRemove }) {
  const isMobile = useIsMobile();
  const [scope, setScope] = useState("month");
  const shown = scope === "month" ? monthExpenses : expenses;
  const total = shown.reduce((s, e) => s + +e.amount, 0);

  const byCategory = {};
  const byVendor = {};
  shown.forEach((e) => {
    byCategory[e.category || "Other"] = (byCategory[e.category || "Other"] || 0) + +e.amount;
    if (e.vendor) byVendor[e.vendor] = (byVendor[e.vendor] || 0) + +e.amount;
  });
  const catRows = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  const venRows = Object.entries(byVendor).sort((a, b) => b[1] - a[1]).slice(0, 6);

  return (
    <div>
      <ExpenseForm month={month} tenants={tenants} onAdd={onAdd} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 14, margin: "18px 0" }}>
        <BigStat label={scope === "month" ? `Spent · ${monthLabel}` : "Spent · all time"} value={money(total)} sub={`${shown.length} entries`} accent="#a83232" />
        {catRows[0] && <BigStat label="Top category" value={money(catRows[0][1])} sub={catRows[0][0]} accent="#8a6a1e" />}
        {venRows[0] && <BigStat label="Top vendor" value={money(venRows[0][1])} sub={venRows[0][0]} accent="#5a6472" />}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {[["month", `This month`], ["all", "All time"]].map(([k, lbl]) => (
          <button key={k} onClick={() => setScope(k)} style={{
            ...S.pill, cursor: "pointer",
            background: scope === k ? "#161f2b" : "#f3f0e9", color: scope === k ? "#f4d488" : "#8a8681",
            border: scope === k ? "none" : "1px solid #ddd7cb",
          }}>{lbl}</button>
        ))}
      </div>

      {(catRows.length > 0 || venRows.length > 0) && (
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 16, marginBottom: 16 }}>
          <BreakdownCard title="By category" rows={catRows} total={total} />
          <BreakdownCard title="By vendor" rows={venRows} total={total} />
        </div>
      )}

      <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "13px 18px", borderBottom: "1px solid #eee9df" }}><div style={S.cardTitle}>Entries</div></div>
        {shown.length === 0 ? (
          <div style={{ padding: 22, textAlign: "center", color: "#8a8681", fontSize: 13 }}>No expenses logged {scope === "month" ? `for ${monthLabel}` : "yet"}. Add one above.</div>
        ) : isMobile ? (
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            {shown.map((e) => <ExpenseCard key={e.id} e={e} onRemove={onRemove} />)}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
              <thead>
                <tr>
                  {["Date", "Category", "Vendor", "Unit", "Note", "Amount", ""].map((h, i) => (
                    <th key={h} style={{ ...S.th, textAlign: i === 5 ? "right" : "left" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.id} style={{ borderBottom: "1px solid #f2eee5" }}>
                    <td style={{ ...S.td, whiteSpace: "nowrap", fontFamily: "'IBM Plex Mono',monospace", fontSize: 12.5 }}>{e.spent_on}</td>
                    <td style={S.td}><span style={{ fontSize: 12, background: "#f3f0e9", padding: "2px 8px", borderRadius: 5, color: "#5a5850" }}>{e.category}</span></td>
                    <td style={{ ...S.td, fontWeight: 600, fontSize: 13 }}>{e.vendor || "—"}</td>
                    <td style={S.td}>{e.unit ? <UnitChip unit={e.unit} /> : <span style={{ fontSize: 11.5, color: "#8a8681" }}>Building</span>}</td>
                    <td style={{ ...S.td, color: "#6b6b66", fontSize: 12.5, maxWidth: 220 }}>{e.note || ""}</td>
                    <td style={{ ...S.td, textAlign: "right" }}><Money v={e.amount} bold /></td>
                    <td style={{ ...S.td, textAlign: "right" }}>
                      <button onClick={() => onRemove(e.id)} style={{ ...S.iconBtn, color: "#b3ada1" }}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* Mobile expense card — the amount and delete action stay visible without scroll. */
function ExpenseCard({ e, onRemove }) {
  return (
    <div style={{ border: "1px solid #f0ece3", borderRadius: 10, padding: 12, background: "#fff", display: "flex", justifyContent: "space-between", gap: 10 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, background: "#f3f0e9", padding: "2px 8px", borderRadius: 5, color: "#5a5850" }}>{e.category}</span>
          {e.unit ? <UnitChip unit={e.unit} /> : <span style={{ fontSize: 11.5, color: "#8a8681" }}>Building</span>}
        </div>
        <div style={{ fontWeight: 600, fontSize: 14, color: "#1c2836", marginTop: 6 }}>{e.vendor || "—"}</div>
        {e.note && <div style={{ fontSize: 12.5, color: "#6b6b66", marginTop: 2 }}>{e.note}</div>}
        <div style={{ fontSize: 11.5, color: "#8a8681", fontFamily: "'IBM Plex Mono',monospace", marginTop: 4 }}>{e.spent_on}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", justifyContent: "space-between", flexShrink: 0 }}>
        <Money v={e.amount} bold />
        <button onClick={() => onRemove(e.id)} style={{ ...S.iconBtn, color: "#b3ada1" }}><Trash2 size={14} /></button>
      </div>
    </div>
  );
}

function BreakdownCard({ title, rows, total }) {
  return (
    <div style={S.card}>
      <div style={{ ...S.cardTitle, marginBottom: 12 }}>{title}</div>
      {rows.length === 0 ? <div style={{ fontSize: 12.5, color: "#8a8681" }}>Nothing to show.</div> : rows.map(([label, val]) => (
        <div key={label} style={{ marginBottom: 9 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 3 }}>
            <span style={{ color: "#4a4842", fontWeight: 600 }}>{label}</span>
            <span style={{ fontFamily: "'IBM Plex Mono',monospace", color: "#1c2836", fontWeight: 600 }}>{money(val)}</span>
          </div>
          <div style={{ height: 6, borderRadius: 4, background: "#eee9df", overflow: "hidden" }}>
            <div style={{ width: `${total ? (val / total) * 100 : 0}%`, height: "100%", background: "#b8892b" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ExpenseForm({ month, tenants, onAdd }) {
  const isMobile = useIsMobile();
  const today = `${month}-01`;
  const [f, setF] = useState({ spent_on: today, amount: "", category: "Repairs", vendor: "", unit: "", note: "" });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const units = [...new Set(tenants.map((t) => t.unit))];
  const submit = () => {
    if (!f.amount) return;
    onAdd({
      spent_on: f.spent_on || today,
      amount: parseFloat(f.amount) || 0,
      category: f.category,
      vendor: f.vendor || null,
      unit: f.unit || null,
      note: f.note || null,
    });
    setF({ spent_on: f.spent_on, amount: "", category: f.category, vendor: "", unit: "", note: "" });
  };
  return (
    <div style={S.card}>
      <div style={{ ...S.cardTitle, marginBottom: 14 }}>Log an expense</div>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1.1fr 1fr 1.2fr 1.2fr 1fr", gap: 10, alignItems: "end" }}>
        <FormField label="Date"><input style={S.field} type="date" value={f.spent_on} onChange={(e) => set("spent_on", e.target.value)} /></FormField>
        <FormField label="Amount"><input style={S.field} inputMode="decimal" placeholder="0.00" value={f.amount} onChange={(e) => set("amount", e.target.value)} /></FormField>
        <FormField label="Category">
          <select style={S.field} value={f.category} onChange={(e) => set("category", e.target.value)}>
            {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </FormField>
        <FormField label="Vendor"><input style={S.field} placeholder="e.g. Con Ed" value={f.vendor} onChange={(e) => set("vendor", e.target.value)} /></FormField>
        <FormField label="Unit">
          <select style={S.field} value={f.unit} onChange={(e) => set("unit", e.target.value)}>
            <option value="">Building-wide</option>
            {units.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </FormField>
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "end" }}>
        <div style={{ flex: 1 }}>
          <FormField label="Note"><input style={S.field} placeholder="What was it for?" value={f.note} onChange={(e) => set("note", e.target.value)} /></FormField>
        </div>
        <button onClick={submit} style={S.primaryBtn}><Plus size={16} /> Add expense</button>
      </div>
    </div>
  );
}

/* ================= TENANTS ================= */
function Tenants({ tenants, onEdit, onAdd }) {
  const [q, setQ] = useState("");
  const list = tenants.filter((t) => (t.name + t.unit + t.program).toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: 1, maxWidth: 320 }}>
          <Search size={15} color="#a8a294" style={{ position: "absolute", left: 12, top: 11 }} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tenants, units, programs"
            style={{ ...S.cellInput, width: "100%", padding: "9px 12px 9px 34px", fontFamily: "'Inter',sans-serif" }} />
        </div>
        <button onClick={onAdd} style={S.primaryBtn}><Plus size={16} /> Add tenant</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))", gap: 14 }}>
        {list.map((t) => (
          <div key={t.id} style={{ ...S.card, padding: 16, cursor: "pointer" }} onClick={() => onEdit(t)}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
              <div style={{ display: "flex", gap: 11, alignItems: "center", minWidth: 0 }}>
                <UnitChip unit={t.unit} big />
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, color: "#1c2836", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</div>
                    {t.active === false && <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: "#8a8681", background: "#efece5", padding: "2px 6px", borderRadius: 4 }}>Archived</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: "#8a8681" }}>{t.beds} · {t.program}</div>
                </div>
              </div>
              <Pencil size={14} color="#b3ada1" />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderTop: "1px solid #f2eee5" }}>
              <MiniStat icon={Banknote} label="Lease rent" v={t.lease_rent} strong />
              <MiniStat icon={Wallet} label="Deposit" v={t.deposit || 0} />
              <div style={{ textAlign: "center", flex: 1 }}>
                <div style={{ fontSize: 10, color: "#a8a294", textTransform: "uppercase", letterSpacing: ".04em", display: "flex", alignItems: "center", justifyContent: "center", gap: 3, marginBottom: 2 }}>
                  <Users size={10} /> Household
                </div>
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, color: "#1c2836" }}>{t.household_size || "—"}</span>
              </div>
            </div>
            {(t.phone || t.lease_end || t.recert_due) && (
              <div style={{ display: "flex", gap: 14, marginTop: 4, fontSize: 11.5, color: "#8a8681", flexWrap: "wrap" }}>
                {t.phone && <span style={{ display: "flex", alignItems: "center", gap: 4 }}><Phone size={11} /> {t.phone}</span>}
                {t.lease_end && <span style={{ display: "flex", alignItems: "center", gap: 4 }}><CalendarClock size={11} /> ends {t.lease_end}</span>}
                {t.recert_due && <span style={{ display: "flex", alignItems: "center", gap: 4 }}><Clock size={11} /> recert {t.recert_due}</span>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniStat({ icon: Icon, label, v, strong }) {
  return (
    <div style={{ textAlign: "center", flex: 1 }}>
      <div style={{ fontSize: 10, color: "#a8a294", textTransform: "uppercase", letterSpacing: ".04em", display: "flex", alignItems: "center", justifyContent: "center", gap: 3, marginBottom: 2 }}>
        <Icon size={10} /> {label}
      </div>
      <Money v={v} size={13} bold={strong} />
    </div>
  );
}

const PROGRAMS = ["Section 8", "CityFHEPS", "FHEPS", "Shelter/FHEPS", "HASA", "SCRIE/DRIE", "Other"];

function FormSection({ children }) {
  return (
    <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
      <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 11.5, color: "#8a6a1e", textTransform: "uppercase", letterSpacing: ".06em", whiteSpace: "nowrap" }}>{children}</span>
      <span style={{ flex: 1, height: 1, background: "#eee9df" }} />
    </div>
  );
}

function TenantModal({ tenant, terms, tenantNotes, propertyId, onClose, onSave, onDelete, onArchive, onAddTerm, onRemoveTerm, onAddNote, onRemoveNote, onParkingChanged, flash }) {
  const isMobile = useIsMobile();
  const [f, setF] = useState(tenant || {
    name: "", unit: "", beds: "2BR", lease_rent: 0, deposit: 0, lease_start: "", lease_end: "", move_in_date: "",
    program: "Section 8", phone: "", alt_phone: "", email: "",
    mailing_address: "", emergency_name: "", emergency_phone: "", household_size: "",
    voucher_number: "", pha_name: "", pha_contact: "", hap_contract_start: "", hap_contract_end: "", recert_due: "",
    active: true,
  });
  const [confirmDel, setConfirmDel] = useState(false);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const num = (k, v) => set(k, v === "" ? 0 : parseFloat(v) || 0);
  const clean = () => {
    const out = { ...f };
    ["lease_start", "lease_end", "move_in_date", "hap_contract_start", "hap_contract_end", "recert_due"].forEach((k) => { if (!out[k]) out[k] = null; });
    out.household_size = out.household_size === "" || out.household_size == null ? null : parseInt(out.household_size, 10) || null;
    return out;
  };
  const grid = { display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12 };

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={{ ...S.modal, width: 640 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 18, color: "#1c2836" }}>{tenant ? "Edit tenant" : "New tenant"}</div>
            {tenant && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 6, background: f.active ? "#e3f3ec" : "#efece5", color: f.active ? "#0f7a54" : "#8a8681", fontSize: 11.5, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", fontFamily: "'Space Grotesk',sans-serif" }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: f.active ? "#12a06e" : "#b3ada1" }} />
                {f.active ? "Active" : "Archived"}
              </span>
            )}
          </div>
          <button onClick={onClose} style={S.iconBtn}><X size={18} /></button>
        </div>

        <div style={grid}>
          <FormSection>Identity &amp; contact</FormSection>
          <Field label="Tenant name" span={2}><input style={S.field} value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label="Phone"><input style={S.field} value={f.phone || ""} onChange={(e) => set("phone", e.target.value)} /></Field>
          <Field label="Alt phone"><input style={S.field} value={f.alt_phone || ""} onChange={(e) => set("alt_phone", e.target.value)} /></Field>
          <Field label="Email" span={2}><input style={S.field} type="email" value={f.email || ""} onChange={(e) => set("email", e.target.value)} /></Field>
          <Field label="Mailing address" span={2}><input style={S.field} value={f.mailing_address || ""} onChange={(e) => set("mailing_address", e.target.value)} /></Field>
          <Field label="Emergency contact"><input style={S.field} placeholder="Name" value={f.emergency_name || ""} onChange={(e) => set("emergency_name", e.target.value)} /></Field>
          <Field label="Emergency phone"><input style={S.field} value={f.emergency_phone || ""} onChange={(e) => set("emergency_phone", e.target.value)} /></Field>
          <Field label="Household size"><input style={S.field} inputMode="numeric" value={f.household_size ?? ""} onChange={(e) => set("household_size", e.target.value.replace(/[^0-9]/g, ""))} /></Field>

          <FormSection>Unit &amp; lease</FormSection>
          <Field label="Unit #"><input style={S.field} value={f.unit} onChange={(e) => set("unit", e.target.value)} /></Field>
          <Field label="Bedrooms"><input style={S.field} value={f.beds} onChange={(e) => set("beds", e.target.value)} /></Field>
          <Field label="Move-in date"><input style={S.field} type="date" value={f.move_in_date || ""} onChange={(e) => set("move_in_date", e.target.value)} /></Field>
          <Field label="Security deposit"><input style={S.field} inputMode="decimal" value={f.deposit} onChange={(e) => num("deposit", e.target.value)} /></Field>
          <Field label="Lease start"><input style={S.field} type="date" value={f.lease_start || ""} onChange={(e) => set("lease_start", e.target.value)} /></Field>
          <Field label="Lease end"><input style={S.field} type="date" value={f.lease_end || ""} onChange={(e) => set("lease_end", e.target.value)} /></Field>

          <FormSection>Subsidy &amp; program</FormSection>
          <Field label="Program">
            <select style={S.field} value={f.program} onChange={(e) => set("program", e.target.value)}>
              {(PROGRAMS.includes(f.program) ? PROGRAMS : [f.program, ...PROGRAMS]).map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Voucher / case #"><input style={S.field} value={f.voucher_number || ""} onChange={(e) => set("voucher_number", e.target.value)} /></Field>
          <Field label="Housing authority (PHA)"><input style={S.field} placeholder="e.g. NYCHA" value={f.pha_name || ""} onChange={(e) => set("pha_name", e.target.value)} /></Field>
          <Field label="PHA contact"><input style={S.field} value={f.pha_contact || ""} onChange={(e) => set("pha_contact", e.target.value)} /></Field>
          <Field label="HAP contract start"><input style={S.field} type="date" value={f.hap_contract_start || ""} onChange={(e) => set("hap_contract_start", e.target.value)} /></Field>
          <Field label="HAP contract end"><input style={S.field} type="date" value={f.hap_contract_end || ""} onChange={(e) => set("hap_contract_end", e.target.value)} /></Field>
          <Field label="Recertification due"><input style={S.field} type="date" value={f.recert_due || ""} onChange={(e) => set("recert_due", e.target.value)} /></Field>

          <FormSection>Rent</FormSection>
          <Field label="Lease rent (total)"><input style={S.field} inputMode="decimal" value={f.lease_rent} onChange={(e) => num("lease_rent", e.target.value)} /></Field>
          <div />
          <div style={{ gridColumn: "1 / -1", fontSize: 12, color: "#6b6b66", display: "flex", alignItems: "flex-start", gap: 7, background: "#faf8f3", padding: "10px 12px", borderRadius: 8 }}>
            <MapPin size={14} color="#b8892b" style={{ marginTop: 1, flexShrink: 0 }} />
            <span>The <b>govt / tenant split</b> is entered each month on the <b>Collections</b> tab — it can change month to month (recerts, assistance, shelter contributions). Only the total lease rent lives here.</span>
          </div>
        </div>

        {tenant && (
          <TenantParking tenant={tenant} propertyId={propertyId} onChanged={onParkingChanged} flash={flash} isMobile={isMobile} />
        )}

        <RentSchedule tenant={tenant} terms={terms} onAddTerm={onAddTerm} onRemoveTerm={onRemoveTerm} />

        {tenant && (
          <div style={{ marginTop: 18, borderTop: "1px solid #eee9df", paddingTop: 16 }}>
            <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 13.5, color: "#1c2836", marginBottom: 10 }}>Notes</div>
            <NotesPanel notes={tenantNotes} onAdd={(body) => onAddNote(body, tenant.id)} onRemove={onRemoveNote} placeholder="e.g. Spoke to tenant 7/15, promised portion by month-end" compact />
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 22, gap: 10, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 8 }}>
            {tenant && (
              <button onClick={() => onArchive(f.id, !f.active)} style={{ ...S.ghostBtn, display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Archive size={14} /> {f.active ? "Archive" : "Reactivate"}
              </button>
            )}
            {tenant && (
              confirmDel ? (
                <button onClick={() => onDelete(f.id)} style={{ ...S.primaryBtn, background: "#a83232", color: "#fff" }}>Confirm delete</button>
              ) : (
                <button onClick={() => setConfirmDel(true)} style={{ ...S.ghostBtn, color: "#a83232" }}>Delete…</button>
              )
            )}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={onClose} style={S.ghostBtn}>Cancel</button>
            <button onClick={() => onSave(clean())} style={S.primaryBtn}>Save tenant</button>
          </div>
        </div>
        {confirmDel && <div style={{ fontSize: 12, color: "#a83232", marginTop: 8, textAlign: "right" }}>Deleting removes this tenant and all their payment history permanently. Prefer <b>Archive</b> to keep the record.</div>}
      </div>
    </div>
  );
}

/* Parking spots owned by a tenant — add/remove, each with its own price + method. */
function TenantParking({ tenant, propertyId, onChanged, flash, isMobile }) {
  const [spots, setSpots] = useState([]);
  const [nw, setNw] = useState({ spot: "", amount: "", method: "Zelle" });
  const load = useCallback(async () => { const { data } = await parkingApi.forTenant(tenant.id); setSpots(data || []); }, [tenant.id]);
  useEffect(() => { load(); }, [load]);
  const add = async () => {
    if (!nw.spot.trim()) return;
    const { error } = await parkingApi.createSpot({
      tenant_id: tenant.id, property_id: propertyId, name: tenant.name,
      spot: nw.spot.trim(), amount: parseFloat(nw.amount) || 0, method: nw.method,
    });
    if (error) { flash?.("error", error.message); return; }
    setNw({ spot: "", amount: "", method: "Zelle" }); await load(); onChanged?.();
  };
  const remove = async (id) => { const { error } = await parkingApi.removeSpot(id); if (error) { flash?.("error", error.message); return; } await load(); onChanged?.(); };
  return (
    <div style={{ marginTop: 18, borderTop: "1px solid #eee9df", paddingTop: 16 }}>
      <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 13.5, color: "#1c2836", marginBottom: 4 }}>Parking spots</div>
      <div style={{ fontSize: 11.5, color: "#8a8681", marginBottom: 12 }}>A tenant can hold more than one spot, each with its own monthly price.</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
        {spots.length === 0 && <div style={{ fontSize: 12.5, color: "#8a8681" }}>No spots yet.</div>}
        {spots.map((s) => (
          <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, background: "#faf8f3", padding: "8px 12px", borderRadius: 8 }}>
            <div style={{ ...S.brassPlaque, background: "#eef1f4", width: 30, height: 30 }}><Car size={14} color="#5a6472" /></div>
            <span style={{ fontWeight: 600, fontSize: 13, color: "#1c2836", minWidth: 60 }}>{s.spot}</span>
            <span style={{ fontSize: 12.5, color: "#5a5850" }}><Money v={s.amount} size={12.5} /> · {s.method}</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => remove(s.id)} style={{ ...S.iconBtn, color: "#b3ada1" }}><Trash2 size={14} /></button>
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1.2fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
        <Field label="Spot / lot"><input style={S.field} placeholder="e.g. Lot 3" value={nw.spot} onChange={(e) => setNw((p) => ({ ...p, spot: e.target.value }))} /></Field>
        <Field label="Price"><input style={S.field} inputMode="decimal" placeholder="0" value={nw.amount} onChange={(e) => setNw((p) => ({ ...p, amount: e.target.value }))} /></Field>
        <Field label="Method">
          <select style={S.field} value={nw.method} onChange={(e) => setNw((p) => ({ ...p, method: e.target.value }))}>
            {["Zelle", "Cash", "Check", "In rent", "Other"].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Field>
        <button onClick={add} style={{ ...S.primaryBtn, padding: "9px 14px" }}><Plus size={15} /></button>
      </div>
    </div>
  );
}

function RentSchedule({ tenant, terms, onAddTerm, onRemoveTerm }) {
  const isMobile = useIsMobile();
  const [nt, setNt] = useState({ effective_from: "", lease_rent: "", govt_expected: "", tenant_expected: "" });
  const set = (k, v) => setNt((p) => ({ ...p, [k]: v }));
  const add = () => {
    if (!tenant || !nt.effective_from) return;
    onAddTerm({
      tenant_id: tenant.id, effective_from: nt.effective_from,
      lease_rent: parseFloat(nt.lease_rent) || 0,
      govt_expected: parseFloat(nt.govt_expected) || 0,
      tenant_expected: parseFloat(nt.tenant_expected) || 0,
      note: "Recertification",
    });
    setNt({ effective_from: "", lease_rent: "", govt_expected: "", tenant_expected: "" });
  };
  return (
    <div style={{ marginTop: 18, borderTop: "1px solid #eee9df", paddingTop: 16 }}>
      <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 13.5, color: "#1c2836", marginBottom: 4 }}>Rent schedule (recertifications)</div>
      <div style={{ fontSize: 11.5, color: "#8a8681", marginBottom: 12 }}>Each dated term sets the govt/tenant split from that date forward. Past months keep the split that was in effect then.</div>
      {!tenant ? (
        <div style={{ fontSize: 12.5, color: "#8a8681", background: "#faf8f3", padding: 12, borderRadius: 8 }}>Save the tenant first, then reopen to add recert terms. A starting term is created automatically.</div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
            {(terms || []).length === 0 && <div style={{ fontSize: 12.5, color: "#8a8681" }}>No terms yet.</div>}
            {(terms || []).map((tm) => (
              <div key={tm.id} style={{ display: "flex", alignItems: "center", gap: 10, background: "#faf8f3", padding: "8px 12px", borderRadius: 8 }}>
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, fontWeight: 600, color: "#7a5c17", minWidth: 84 }}>{tm.effective_from}</span>
                <span style={{ fontSize: 12, color: "#5a5850" }}>rent {money(tm.lease_rent)} · govt {money(tm.govt_expected)} · tenant {money(tm.tenant_expected)}</span>
                <span style={{ flex: 1 }} />
                <button onClick={() => onRemoveTerm(tm.id)} style={{ ...S.iconBtn, color: "#b3ada1" }}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1.1fr 1fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
            <Field label="Effective from"><input style={S.field} type="date" value={nt.effective_from} onChange={(e) => set("effective_from", e.target.value)} /></Field>
            <Field label="Rent"><input style={S.field} inputMode="decimal" placeholder="0" value={nt.lease_rent} onChange={(e) => set("lease_rent", e.target.value)} /></Field>
            <Field label="Govt"><input style={S.field} inputMode="decimal" placeholder="0" value={nt.govt_expected} onChange={(e) => set("govt_expected", e.target.value)} /></Field>
            <Field label="Tenant"><input style={S.field} inputMode="decimal" placeholder="0" value={nt.tenant_expected} onChange={(e) => set("tenant_expected", e.target.value)} /></Field>
            <button onClick={add} style={{ ...S.primaryBtn, padding: "9px 14px" }}><Plus size={15} /></button>
          </div>
        </>
      )}
    </div>
  );
}

function Field({ label, span, children }) {
  return (
    <label style={{ gridColumn: span === 2 ? "1 / -1" : "auto" }}>
      <div style={{ fontSize: 11.5, color: "#8a8681", marginBottom: 5, fontWeight: 600 }}>{label}</div>
      {children}
    </label>
  );
}
function FormField({ label, children }) {
  return (
    <label>
      <div style={{ fontSize: 11.5, color: "#8a8681", marginBottom: 5, fontWeight: 600 }}>{label}</div>
      {children}
    </label>
  );
}

/* ================= NOTES / LOG ================= */
function NotesPanel({ notes, onAdd, onRemove, placeholder, compact }) {
  const [body, setBody] = useState("");
  const post = () => { if (!body.trim()) return; onAdd(body.trim()); setBody(""); };
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={placeholder || "Add a note…"} rows={compact ? 2 : 3}
          style={{ ...S.field, flex: 1, resize: "vertical", fontFamily: "'Inter',sans-serif", lineHeight: 1.4 }} />
        <button onClick={post} style={{ ...S.primaryBtn, alignSelf: "flex-start" }}><Plus size={15} /> Post</button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {notes.length === 0 && <div style={{ fontSize: 12.5, color: "#8a8681" }}>No notes yet.</div>}
        {notes.map((n) => (
          <div key={n.id} style={{ background: "#faf8f3", borderRadius: 9, padding: "10px 13px", display: "flex", gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: "#2c2c28", whiteSpace: "pre-wrap", lineHeight: 1.45 }}>{n.body}</div>
              <div style={{ fontSize: 10.5, color: "#a29d92", marginTop: 5 }}>
                {n.author_email ? `${n.author_email} · ` : ""}{n.created_at ? new Date(n.created_at).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : ""}
              </div>
            </div>
            <button onClick={() => onRemove(n.id)} style={{ ...S.iconBtn, color: "#b3ada1", alignSelf: "flex-start" }}><Trash2 size={14} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

function LogTab({ notes, onAdd, onRemove }) {
  return (
    <div style={{ maxWidth: 720 }}>
      <div style={S.card}>
        <div style={{ ...S.cardTitle, marginBottom: 4 }}>Building activity log</div>
        <div style={{ fontSize: 12, color: "#8a8681", marginBottom: 14 }}>Shared notes for the whole building — repairs, calls, agency contacts, anything worth a paper trail. Everyone on the account sees these.</div>
        <NotesPanel notes={notes} onAdd={onAdd} onRemove={onRemove} placeholder="e.g. Boiler serviced by ABC Mechanical, $450 — logged under Expenses too" />
      </div>
    </div>
  );
}

/* ================= PARKING ================= */
function Parking({ parking, parkingRec, monthLabel, setReceived, setActive, tenants = [], propertyId, onChanged, flash }) {
  const [edit, setEdit] = useState(null); // spot object, or "new"
  const active = parking.filter((p) => p.active !== false);
  const inactive = parking.filter((p) => p.active === false);
  const total = active.reduce((s, p) => s + (+p.amount || 0), 0);
  const collected = active.reduce((s, p) => s + (+parkingRec[p.id] || 0), 0);
  const tenantName = (id) => { const t = tenants.find((x) => x.id === id); return t ? `${t.unit} · ${t.name}` : null; };
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, color: "#8a8681" }}>Manage spots and prices, then record what's received each month.</div>
        <button onClick={() => setEdit("new")} style={S.primaryBtn}><Plus size={16} /> Add spot</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 14, marginBottom: 18 }}>
        <BigStat label={`Parking roll · ${monthLabel}`} value={money(total)} sub={`${active.length} active spot${active.length === 1 ? "" : "s"}`} accent="#1c2836" />
        <BigStat label="Collected" value={money(collected)} sub={`${money(Math.max(total - collected, 0))} outstanding`} accent="#0f7a54" />
      </div>
      <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
        {active.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "#8a8681", fontSize: 13 }}>No active parking spots. Add one above — residents or non-residents.</div>
        ) : active.map((p, i) => (
          <ParkingRow key={p.id} p={p} received={+parkingRec[p.id] || 0} onCommit={(v) => setReceived(p.id, v)} onEdit={() => setEdit(p)} tenantLabel={tenantName(p.tenant_id)} last={i === active.length - 1} />
        ))}
      </div>
      <div style={{ fontSize: 12, color: "#8a8681", marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
        <Pencil size={12} /> Tap a spot to edit its name, lot, price, or method. Enter the amount actually received each month — parking income also appears on Collections and the Overview.
      </div>

      {inactive.length > 0 && (
        <div style={{ marginTop: 26 }}>
          <div style={{ ...S.cardTitle, marginBottom: 8, color: "#8a8681" }}>Inactive spots · {inactive.length}</div>
          <div style={{ ...S.card, padding: 0, overflow: "hidden", opacity: 0.75 }}>
            {inactive.map((p, i) => (
              <ParkingRow key={p.id} p={p} received={0} inactive
                onEdit={() => setEdit(p)} tenantLabel={tenantName(p.tenant_id)} last={i === inactive.length - 1} />
            ))}
          </div>
          <div style={{ fontSize: 12, color: "#8a8681", marginTop: 8 }}>
            Deactivated spots stay out of future months but keep every month they were active. Reopen one to reactivate it.
          </div>
        </div>
      )}

      {edit && (
        <ParkingModal spot={edit === "new" ? null : edit} tenants={tenants} propertyId={propertyId} flash={flash} setActive={setActive}
          onClose={() => setEdit(null)} onSaved={() => { setEdit(null); onChanged?.(); }} />
      )}
    </div>
  );
}

/* One parking spot's received-amount entry for the month (reconciled, not automatic). */
function ParkingRow({ p, received, onCommit, onEdit, tenantLabel, note, onCommitNote, inactive, last }) {
  const expected = +p.amount || 0;
  // "In rent" spots are driven by the tenant's rent status (a DB trigger keeps
  // them in sync), so they're shown read-only here.
  const inRent = p.method === "In rent" && !!p.tenant_id;
  const status = received <= 0.001 ? "owed" : received + 0.5 >= expected ? "paid" : "partial";
  return (
    <div style={{ borderBottom: last ? "none" : "1px solid #f2eee5" }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: onCommitNote ? "13px 18px 4px" : "13px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
        {onEdit ? (
          <button onClick={onEdit} title="Edit spot" style={{ ...S.brassPlaque, background: "#eef1f4", width: 34, height: 34, border: "none", cursor: "pointer" }}><Car size={16} color="#5a6472" /></button>
        ) : (
          <div style={{ ...S.brassPlaque, background: "#eef1f4", width: 34, height: 34 }}><Car size={16} color="#5a6472" /></div>
        )}
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: "#1c2836", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", cursor: onEdit ? "pointer" : "default" }} onClick={onEdit}>{p.name || "(unnamed)"}</div>
            {inactive && <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "#8a8681", background: "#f0ece3", borderRadius: 5, padding: "2px 6px", flexShrink: 0 }}>Inactive</span>}
          </div>
          <div style={{ fontSize: 11.5, color: "#8a8681" }}>
            {p.spot} · {p.method} · expected <button onClick={() => onCommit?.(expected)} style={{ border: "none", background: "transparent", color: "#3a6ea5", fontWeight: 600, padding: 0, fontFamily: "'IBM Plex Mono',monospace", fontSize: 11.5, cursor: onCommit ? "pointer" : "default" }}>{money(expected)}</button>
            {tenantLabel === undefined ? null : tenantLabel ? <span style={{ color: "#7a5c17" }}> · {tenantLabel}</span> : <span style={{ color: "#a8a294" }}> · non-resident</span>}
          </div>
          {(p.plate || p.make || p.model || p.vehicle_year) && (
            <div style={{ fontSize: 11, color: "#a29d92", marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {[p.vehicle_year, p.make, p.model].filter(Boolean).join(" ")}{p.plate ? ` · ${p.plate}` : ""}
            </div>
          )}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
        {inactive ? (
          <div style={{ fontSize: 12, color: "#a8a294", fontStyle: "italic" }}>stopped parking</div>
        ) : (
          <>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, color: "#a8a294", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 2 }}>{inRent ? "In rent · auto" : "Received"}</div>
              {inRent ? (
                <div title="Auto: paid when the tenant's rent is fully paid" style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 600, fontSize: 13, color: received > 0.5 ? "#1c2836" : "#9a958c", minWidth: 84, textAlign: "right", padding: "7px 0" }}>{received > 0.5 ? money(received) : "—"}</div>
              ) : (
                <NumCell value={received || ""} onCommit={onCommit} />
              )}
            </div>
            <Stamp status={status} />
          </>
        )}
        {onEdit && <button onClick={onEdit} style={{ ...S.iconBtn, color: "#b3ada1" }} title="Edit spot"><Pencil size={15} /></button>}
      </div>
    </div>
      {onCommitNote && (
        <div style={{ padding: "0 18px 12px" }}>
          <RowNote value={note} onCommit={onCommitNote} />
        </div>
      )}
    </div>
  );
}

/* Add / edit a parking spot — works for residents (assigned to a tenant) or
   non-residents (unassigned). */
function ParkingModal({ spot, tenants, propertyId, onClose, onSaved, flash, setActive }) {
  const [f, setF] = useState(spot || { name: "", spot: "", amount: 0, method: "Zelle", tenant_id: "", plate: "", make: "", model: "", vehicle_year: "" });
  const [confirmDel, setConfirmDel] = useState(false);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const save = async () => {
    if (!(f.name || "").trim() && !(f.spot || "").trim()) { flash?.("error", "Add a name or a lot/spot label."); return; }
    const payload = {
      name: (f.name || "").trim(), spot: (f.spot || "").trim(),
      amount: parseFloat(f.amount) || 0, method: f.method, tenant_id: f.tenant_id || null, property_id: propertyId,
      plate: (f.plate || "").trim() || null, make: (f.make || "").trim() || null, model: (f.model || "").trim() || null,
      vehicle_year: f.vehicle_year === "" || f.vehicle_year == null ? null : parseInt(f.vehicle_year, 10) || null,
    };
    const { error } = spot?.id ? await parkingApi.updateSpot(spot.id, payload) : await parkingApi.createSpot(payload);
    if (error) { flash?.("error", error.message); return; }
    onSaved();
  };
  const del = async () => { const { error } = await parkingApi.removeSpot(spot.id); if (error) { flash?.("error", error.message); return; } onSaved(); };
  const isInactive = spot?.active === false;
  const toggleActive = async () => { await setActive?.(spot.id, isInactive); onSaved(); };
  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={{ ...S.modal, width: 460 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 18, color: "#1c2836" }}>{spot ? "Edit parking spot" : "Add parking spot"}</div>
          <button onClick={onClose} style={S.iconBtn}><X size={18} /></button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Renter name" span={2}><input style={S.field} placeholder="Who rents this spot" value={f.name || ""} onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label="Spot / lot"><input style={S.field} placeholder="e.g. Lot 3" value={f.spot || ""} onChange={(e) => set("spot", e.target.value)} /></Field>
          <Field label="Monthly price"><input style={S.field} inputMode="decimal" value={f.amount} onChange={(e) => set("amount", e.target.value === "" ? 0 : parseFloat(e.target.value) || 0)} /></Field>
          <Field label="Method">
            <select style={S.field} value={f.method || "Zelle"} onChange={(e) => set("method", e.target.value)}>
              {["Zelle", "Cash", "Check", "In rent", "Other"].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="Assigned to">
            <select style={S.field} value={f.tenant_id || ""} onChange={(e) => set("tenant_id", e.target.value)}>
              <option value="">Non-resident (unassigned)</option>
              {tenants.map((t) => <option key={t.id} value={t.id}>{t.unit} · {t.name}</option>)}
            </select>
          </Field>

          <FormSection>Vehicle</FormSection>
          <Field label="License plate"><input style={S.field} value={f.plate || ""} onChange={(e) => set("plate", e.target.value)} /></Field>
          <Field label="Year"><input style={S.field} inputMode="numeric" placeholder="e.g. 2019" value={f.vehicle_year ?? ""} onChange={(e) => set("vehicle_year", e.target.value.replace(/[^0-9]/g, ""))} /></Field>
          <Field label="Make"><input style={S.field} placeholder="e.g. Honda" value={f.make || ""} onChange={(e) => set("make", e.target.value)} /></Field>
          <Field label="Model"><input style={S.field} placeholder="e.g. Civic" value={f.model || ""} onChange={(e) => set("model", e.target.value)} /></Field>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 22, gap: 10 }}>
          <div>
            {spot && (confirmDel ? (
              <button onClick={del} style={{ ...S.primaryBtn, background: "#a83232", color: "#fff" }}>Confirm delete</button>
            ) : (
              <button onClick={() => setConfirmDel(true)} style={{ ...S.ghostBtn, color: "#a83232" }}>Delete…</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            {spot && setActive && (
              <button onClick={toggleActive} style={{ ...S.ghostBtn, color: isInactive ? "#0f7a54" : "#7a5c17" }}>
                {isInactive ? "Reactivate" : "Deactivate"}
              </button>
            )}
            <button onClick={onClose} style={S.ghostBtn}>Cancel</button>
            <button onClick={save} style={S.primaryBtn}>Save spot</button>
          </div>
        </div>
      </div>
    </div>
  );
}
