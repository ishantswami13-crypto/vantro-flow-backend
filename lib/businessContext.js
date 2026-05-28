// FILE: lib/businessContext.js
/**
 * Extracts and normalizes the business context from the request.
 * Ensure that all domain services use this to enforce tenant isolation.
 */
function getBusinessContext(req) {
  if (!req.user) {
    throw new Error('Authentication required for business context');
  }

  // Fallback for MVP architecture: userId acts as businessId if businessId is missing
  const userId = req.user.userId || req.user.id;
  const businessId = req.user.businessId || userId;
  const role = req.user.role || 'owner';
  const email = req.user.email || null;

  if (!userId) {
    throw new Error('User ID is missing from authentication context');
  }

  return {
    userId,
    businessId,
    role,
    email
  };
}

module.exports = {
  getBusinessContext
};
