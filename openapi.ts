export const OPENAPI_SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'PharmaSync Head Office & Branch POS API',
    version: '1.0.0',
    description:
      'Offline-First Multi-Branch Pharmacy Inventory, FEFO Batch Management, Recall Compliance, and Resumable Bidirectional Synchronization REST API.',
  },
  servers: [{ url: '/api', description: 'Local PharmaSync Gateway' }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
    schemas: {
      ProblemDetails: {
        type: 'object',
        description: 'RFC 9457 Problem Details error payload',
        properties: {
          type: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'integer' },
          detail: { type: 'string' },
          traceId: { type: 'string' },
          errors: { type: 'object', additionalProperties: { type: 'string' } },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/auth/status': { get: { summary: 'Check workspace admin claim bootstrap status', security: [] } },
    '/auth/bootstrap': { post: { summary: 'One-time secure Super Admin password setup', security: [] } },
    '/auth/login': { post: { summary: 'Authenticate user and issue JWT Bearer token', security: [] } },
    '/dashboard': { get: { summary: 'Head Office or Branch operational dashboard KPIs and charts' } },
    '/medicines': {
      get: { summary: 'List medicine catalogue with pack hierarchy and search/filter' },
      post: { summary: 'Create medicine in central Head Office catalogue' },
    },
    '/medicines/{id}': {
      put: { summary: 'Update medicine metadata or central selling price (increments version)' },
    },
    '/batches': {
      get: { summary: 'List FEFO-sorted batch inventory across branches or single branch' },
      post: { summary: 'Receive stock batch into branch local database and queue sync' },
    },
    '/pos/barcode/{code}': { get: { summary: 'Sub-50ms local barcode lookup with FEFO batch preview' } },
    '/pos/sales': {
      get: { summary: 'List branch or central POS sales history' },
      post: { summary: 'Execute FEFO-validated POS sale (online or offline queued with idempotency key)' },
    },
    '/pos/returns': { post: { summary: 'Process POS sale return and restock non-recalled batch' } },
    '/prescriptions': { get: { summary: 'List dispensed prescription register' } },
    '/transfers': {
      get: { summary: 'List inter-branch transfers' },
      post: { summary: 'Dispatch branch-to-branch transfer (DISPATCHED)' },
    },
    '/transfers/{id}/transition': {
      post: { summary: 'Advance transfer state (IN_TRANSIT -> RECEIVED) with discrepancy tracking' },
    },
    '/recalls': {
      get: { summary: 'List central batch recalls with branch-wise impact breakdown' },
      post: { summary: 'Issue central batch recall and notify all branches' },
    },
    '/reordering': { get: { summary: 'Compute 30-day velocity reorder suggestions by branch & product' } },
    '/stock-counts': {
      get: { summary: 'List stock count & negative-stock reconciliation tasks' },
      post: { summary: 'Complete physical stock count and reconcile variance' },
    },
    '/reports/{reportType}': { get: { summary: 'Run paginated, sortable, filterable database reports' } },
    '/branches': {
      get: { summary: 'List pharmacy branches with connectivity & pending sync metrics' },
      post: { summary: 'Register new pharmacy branch' },
    },
    '/branches/{id}/connectivity': { patch: { summary: 'Toggle branch online/offline simulation state' } },
    '/users': {
      get: { summary: 'List users and RBAC role assignments' },
      post: { summary: 'Create user with scrypt-hashed password and role' },
    },
    '/sync/status': { get: { summary: 'Inspect branch transactional outbox, acks, and conflict log' } },
    '/sync/run': { post: { summary: 'Execute bidirectional resumable sync (Branch <-> Head Office)' } },
    '/sync/conflicts/{id}/resolve': { post: { summary: 'Mark deterministic sync conflict as reviewed/resolved' } },
    '/actuator/health': { get: { summary: 'Liveness probe', security: [] } },
    '/actuator/ready': { get: { summary: 'Readiness probe (Head Office + Branch SQLite check)', security: [] } },
    '/actuator/metrics': { get: { summary: 'Micrometer-style operational metrics' } },
  },
};
