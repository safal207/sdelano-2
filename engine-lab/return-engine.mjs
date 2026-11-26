// RA-002: pure intent-first decision engine. No I/O, clock, DOM or storage.
// Adapters supply explicit intent, verified catalogue and permissions.
// All money values use integer minor units with an explicit ISO currency.
const PRODUCTS = Object.freeze(["done","atelier23","robys","ai-path","habit","zenit"]);
const COMMERCIAL = new Set(["atelier23","robys"]);
const CATEGORY = Object.freeze({
  done: ["resume","new_task"], atelier23: ["date","work","travel","event"],
  robys: ["work","travel","rest"], "ai-path": ["learn"],
  habit: ["next_step"], zenit: ["training"]
});
const MAX_TIME = 8640000000000000;
const safeInt = x => Number.isSafeInteger(x) && x >= 0;
const time = x => safeInt(x) && x <= MAX_TIME;
const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
const token = x => typeof x === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(x);
const currency = x => typeof x === "string" && /^[A-Z]{3}$/.test(x);
const money = x => object(x) && safeInt(x.amount) && currency(x.currency);
const known = (product, category) => PRODUCTS.includes(product) && CATEGORY[product].includes(category);
const none = reason => ({kind:"none", reason, action:null, evidence:[]});

export function discoverIntent(product, context) {
  const unknown = status => ({status, category:null, validity:null, source:"unknown"});
  if (!PRODUCTS.includes(product) || !object(context) || !time(context.now)) return unknown("invalid");
  // An explicit session decline overrides even stale cached answers.
  if (context.declined === true || context.currentIntent?.status === "declined") return unknown("declined");
  if (context.currentIntent == null) return unknown("unknown");
  const i = context.currentIntent;
  if (!object(i) || i.status !== "stated" || i.source !== "explicit" ||
      !known(product,i.category) || !time(i.statedAt) || !time(i.expiresAt) ||
      i.statedAt > context.now || i.expiresAt <= i.statedAt) return unknown("invalid");
  if (context.now >= i.expiresAt) return unknown("expired");
  return {status:"stated",category:i.category,validity:"current",source:"explicit"};
}

export function matchOpportunity(product, intent, context, policy) {
  const no = reason => ({kind:"none",actionId:null,reason,constraintsChecked:[]});
  if (!PRODUCTS.includes(product) || intent?.status !== "stated" ||
      !known(product,intent.category)) return no("no_current_intent");
  if (!object(context) || !time(context.now) || !object(policy) ||
      !Array.isArray(policy.catalog) || policy.catalog.length > 10000 ||
      !Array.isArray(policy.availableActions)) return no("invalid_policy");
  const commercial = COMMERCIAL.has(product);
  if (commercial && policy.allowOffers !== true) return no("offers_not_allowed");
  if (context.budget != null && !money(context.budget)) return no("invalid_budget");
  // Duplicate IDs are ambiguous; never select either entry.
  const seen = new Set(), duplicate = new Set();
  for (const item of policy.catalog) {
    if (!object(item) || !token(item.id)) continue;
    if (seen.has(item.id)) duplicate.add(item.id);
    seen.add(item.id);
  }
  let best = null;
  let comparableCurrency = null;
  let mixedCurrency = false;
  for (const item of policy.catalog) {
    if (!object(item) || !token(item.id) || duplicate.has(item.id) ||
        item.product !== product || item.category !== intent.category ||
        item.available !== true || !time(item.verifiedAt) ||
        !time(item.validUntil) || item.verifiedAt > context.now ||
        item.validUntil <= context.now || !policy.availableActions.includes(item.id) ||
        !safeInt(item.relevance) || item.relevance > 100) continue;
    if (commercial && (!money(item.price) ||
        !["additional","replacement","standalone"].includes(item.offerType) ||
        (context.budget != null && (item.price.currency !== context.budget.currency ||
         item.price.amount > context.budget.amount)))) continue;
    if (commercial) {
      if (comparableCurrency !== null && comparableCurrency !== item.price.currency) mixedCurrency = true;
      comparableCurrency = item.price.currency;
    }
    // Rank by explicit adapter relevance, then lower comparable price,
    // then a stable ID. Never rank by margin or higher spend.
    if (!best || item.relevance > best.relevance ||
        (item.relevance === best.relevance && (
          (commercial && item.price.currency === best.price.currency && item.price.amount < best.price.amount) ||
          ((!commercial || item.price.currency !== best.price.currency || item.price.amount === best.price.amount) && item.id < best.id)
        ))) best = item;
  }
  if (!best) return no("no_verified_match");
  if (mixedCurrency) return no("ambiguous_currency");
  return {kind:"action",actionId:best.id,reason:"verified_match",
    constraintsChecked:commercial ? ["intent","availability","validity","permission","price", ...(context.budget != null ? ["budget"] : [])] : ["intent","availability","validity","permission"]};
}

export function recommendReturn(snapshot, context, policy) {
  if (!object(snapshot) || snapshot.schemaVersion !== 1 || !PRODUCTS.includes(snapshot.product) ||
      !object(context) || !time(context.now) || !object(policy) ||
      !safeInt(policy.minGap) || !Array.isArray(policy.availableActions) ||
      (snapshot.lastUsefulActionAt !== null && (!time(snapshot.lastUsefulActionAt) || snapshot.lastUsefulActionAt > context.now)) ||
      (snapshot.pendingCount !== null && !safeInt(snapshot.pendingCount))) return none("invalid_input");
  const product = snapshot.product;
  const intent = discoverIntent(product,context);
  if (intent.status === "invalid") return none("invalid_intent");
  const allow = a => policy.availableActions.includes(a);
  const decision = (kind,reason,action,evidence) => ({kind,reason,action,evidence});
  if (intent.status === "stated") {
    const match = matchOpportunity(product,intent,context,policy);
    if (match.kind === "action") return decision(COMMERCIAL.has(product) ? "offer" : (product === "done" && intent.category === "new_task" ? "start" : "resume"),
      match.reason,match.actionId,match.constraintsChecked);
    // A stated request without a fit must not be replaced by an unrelated sale.
    return none(match.reason);
  }
  // Existing useful action is preferred to asking another question.
  if (product === "done") {
    if (context.entrySource === "referral") return allow("start_task") ?
      decision("start","referral","start_task",["referral"]) : none("action_unavailable");
    if (snapshot.lastUsefulActionAt === null && snapshot.pendingCount === 0)
      return allow("start_task") ? decision("start","first_visit","start_task",["empty_list"]) : none("action_unavailable");
    if (snapshot.lastUsefulActionAt !== null && context.now-snapshot.lastUsefulActionAt >= policy.minGap) {
      if (snapshot.pendingCount > 0 && allow("resume_task"))
        return decision("resume","return_pending","resume_task",["elapsed_gap","pending"]);
      if (snapshot.pendingCount === 0 && allow("start_task"))
        return decision("start","return_empty","start_task",["elapsed_gap","empty_list"]);
    }
    return none("ordinary_flow");
  }
  if (intent.status === "declined" || context.askedThisSession === true) return none("respect_choice");
  if (policy.allowQuestion === true && context.questionAppropriate === true &&
      allow("ask_intent") && (intent.status === "unknown" || intent.status === "expired"))
    return decision("ask_intent","optional_question","ask_intent",["appropriate_context"]);
  return none("ordinary_flow");
}
