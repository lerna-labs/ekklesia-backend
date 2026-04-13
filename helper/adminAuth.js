// Provisional admin gate. Two paths:
//   1) JWT claim `role === "admin"` (future: proper role model)
//   2) userId present in ADMIN_USER_IDS env (comma-separated bech32 ids)
//
// This is deliberately minimal — the plan flags the concrete admin role
// model as an open item. Keep this swappable.

import { verifyToken } from "./verifyToken.js";

function adminIdSet() {
  const raw = process.env.ADMIN_USER_IDS || "";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

export function isAdmin(req, res, next) {
  const result = verifyToken(req);
  if (result.status !== "success") {
    return res.status(result.code || 401).json({ status: "error", message: result.message });
  }
  const admins = adminIdSet();
  const hasAdminClaim = result.role === "admin";
  const onAllowList = admins.has(result.userId);
  if (!hasAdminClaim && !onAllowList) {
    return res.status(403).json({ status: "error", message: "Admin privileges required" });
  }
  req.auth = { userId: result.userId, role: hasAdminClaim ? "admin" : "admin-allowlist" };
  next();
}
