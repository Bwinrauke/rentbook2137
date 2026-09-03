import { supabase } from "./supabase";

/* ---------------- AUTH ---------------- */
export const authApi = {
  signIn: (email, password) => supabase.auth.signInWithPassword({ email, password }),
  signUp: (email, password) => supabase.auth.signUp({ email, password }),
  signOut: () => supabase.auth.signOut(),
  getSession: () => supabase.auth.getSession(),
  onChange: (cb) => supabase.auth.onAuthStateChange((_e, s) => cb(s)),
  async isMember() {
    // Look up only the signed-in user's own membership row, so the check stays
    // correct no matter how many members exist (never relies on RLS to return
    // exactly one row).
    const { data: userData } = await supabase.auth.getUser();
    const uid = userData?.user?.id;
    if (!uid) return { member: false, role: null };
    const { data, error } = await supabase.from("members").select("role").eq("user_id", uid).maybeSingle();
    if (error) return { member: false, role: null };
    return { member: !!data, role: data?.role || null };
  },
};

/* ---------------- PROPERTIES ---------------- */
export const propertiesApi = {
  list: () => supabase.from("properties").select("*").order("created_at"),
};

/* ---------------- TENANTS ---------------- */
// list is scoped to a property; upsert passes every column through (rich fields included).
export const tenantsApi = {
  list: (propertyId) => {
    let q = supabase.from("tenants").select("*").order("unit");
    if (propertyId) q = q.eq("property_id", propertyId);
    return q;
  },
  upsert: (t) => supabase.from("tenants").upsert(t).select().single(),
  setActive: (id, active) =>
    supabase.from("tenants").update({ active, archived_at: active ? null : new Date().toISOString() }).eq("id", id),
  remove: (id) => supabase.from("tenants").delete().eq("id", id),
};

/* ---------------- RENT TERMS (effective-dated splits) ---------------- */
export const rentTermsApi = {
  list: () => supabase.from("rent_terms").select("*").order("effective_from"),
  add: (row) => supabase.from("rent_terms").insert(row).select().single(),
  remove: (id) => supabase.from("rent_terms").delete().eq("id", id),
};

/* ---------------- PARKING ---------------- */
// Spots belong to a property and optionally to a tenant (a tenant may hold several).
export const parkingApi = {
  list: (propertyId) => {
    let q = supabase.from("parking_spots").select("*").order("spot");
    if (propertyId) q = q.eq("property_id", propertyId);
    return q;
  },
  forTenant: (tenantId) => supabase.from("parking_spots").select("*").eq("tenant_id", tenantId).order("spot"),
  createSpot: (row) => supabase.from("parking_spots").insert(row).select().single(),
  updateSpot: (id, patch) => supabase.from("parking_spots").update(patch).eq("id", id).select().single(),
  removeSpot: (id) => supabase.from("parking_spots").delete().eq("id", id),
  paidForMonth: (month) => supabase.from("parking_payments").select("*").eq("month", month),
  allPaid: () => supabase.from("parking_payments").select("spot_id, month, paid, amount"),
  setPaid: (spot_id, month, paid) =>
    supabase.from("parking_payments").upsert({ spot_id, month, paid }, { onConflict: "spot_id,month" }),
  // Record the dollars actually received for a spot in a month (reconciled).
  setReceived: (spot_id, month, amount) =>
    supabase.from("parking_payments").upsert({ spot_id, month, amount, paid: (+amount || 0) > 0.001 }, { onConflict: "spot_id,month" }),
  // Free-text note for a spot's month (leaves the received amount untouched).
  setNote: (spot_id, month, notes) =>
    supabase.from("parking_payments").upsert({ spot_id, month, notes }, { onConflict: "spot_id,month" }),
};

/* ---------------- PAYMENTS ---------------- */
export const paymentsApi = {
  statusForMonth: (month) => supabase.from("payment_status").select("*").eq("month", month),
  allStatus: () => supabase.from("payment_status").select("tenant_id, month, status, total"),
  allRaw: () => supabase.from("payments").select("tenant_id, month, govt, portion, assistance"),
  save: (row) =>
    supabase.from("payments").upsert(row, { onConflict: "tenant_id,month" }).select().single(),
};

/* ---------------- EXPENSES ---------------- */
export const expensesApi = {
  list: (propertyId) => {
    let q = supabase.from("expenses").select("*").order("spent_on", { ascending: false });
    if (propertyId) q = q.eq("property_id", propertyId);
    return q;
  },
  add: (row) => supabase.from("expenses").insert(row).select().single(),
  remove: (id) => supabase.from("expenses").delete().eq("id", id),
};

/* ---------------- NOTES / LOG ---------------- */
export const notesApi = {
  list: (propertyId) => {
    let q = supabase.from("notes").select("*").order("created_at", { ascending: false });
    if (propertyId) q = q.eq("property_id", propertyId);
    return q;
  },
  add: (row) => supabase.from("notes").insert(row).select().single(),
  remove: (id) => supabase.from("notes").delete().eq("id", id),
};

/* ---------------- AUDIT LOG (change log by user) ----------------
   audit_log is append-only and captures every insert/update/delete with the
   actor, timestamp, and full before/after row. `recent` powers the Activity
   feed; `forRow` powers a record's version history (e.g. one tenant's month). */
export const auditApi = {
  recent: (propertyId, limit = 200) => {
    let q = supabase.from("audit_log").select("*").order("at", { ascending: false }).limit(limit);
    if (propertyId) q = q.or(`property_id.eq.${propertyId},property_id.is.null`);
    return q;
  },
  forRow: (table, rowId) =>
    supabase.from("audit_log").select("*").eq("table_name", table).eq("row_id", rowId).order("at", { ascending: true }),
};

/* ---------------- REALTIME (live sync via Postgres change webhooks) ----------------
   Supabase streams every insert/update/delete on the subscribed tables over a
   websocket. When the bookkeeper edits on their phone, the owner's screen updates
   without a refresh — and vice versa. onChange gets the raw change payload (with
   payload.table); onStatus reports the connection state ("SUBSCRIBED", etc.). */
export const realtime = {
  // Tables the app reads. Each becomes a live channel.
  TABLES: ["tenants", "rent_terms", "parking_spots", "parking_payments", "payments", "expenses", "notes", "properties", "audit_log"],
  subscribe(onChange, onStatus) {
    if (!supabase) return () => {};
    const channel = supabase.channel("rentbook-live");
    this.TABLES.forEach((table) => {
      channel.on("postgres_changes", { event: "*", schema: "public", table }, (payload) => {
        onChange?.({ ...payload, table });
      });
    });
    channel.subscribe((status) => onStatus?.(status));
    return () => { supabase.removeChannel(channel); };
  },
};
