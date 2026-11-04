import { Router } from 'express';
import { AuthedRequest, requireCaseRole, requireCanCreateCases } from '../middleware/auth';
import { requireApiToken } from '../middleware/apitoken';
import { listCasesHandler, createCaseHandler } from './cases';
import { uploadImportHandler, pathImportHandler, importStatusHandler, upload } from './imports';
import { listDocumentsHandler } from './documents';

// Versioned public REST API (token authenticated), mounted at /api/v1.
// Every route runs requireApiToken FIRST so req.user is set exactly as the
// cookie session would set it; downstream requireCaseRole / requireCanCreateCases
// then enforce the SAME per-case RBAC as the browser. Handlers are reused
// verbatim from the cookie routes — no ingest/processing logic is duplicated.
const router = Router();

// All v1 routes require a valid API token.
router.use(requireApiToken);

// ---- GET /api/v1/me — whoami / token check ----------------------------------
router.get('/me', (req: AuthedRequest, res) => {
  const u = req.user!;
  res.json({ id: u.id, username: u.username, isSystemAdmin: u.isSystemAdmin });
});

// ---- GET /api/v1/cases — cases the token owner can access -------------------
router.get('/cases', listCasesHandler);

// ---- POST /api/v1/cases — create a case (if the owner may) ------------------
router.post('/cases', requireCanCreateCases, createCaseHandler);

// ---- POST /api/v1/cases/:caseId/imports — multipart loadfile upload ---------
// case_manager+ on the case. requireApiToken (router.use) runs before
// requireCaseRole, which reads :caseId from the path.
router.post('/cases/:caseId/imports', requireCaseRole('case_manager'), upload.any(), uploadImportHandler);

// ---- POST /api/v1/cases/:caseId/imports/path — server-path loadfile ingest --
router.post('/cases/:caseId/imports/path', requireCaseRole('case_manager'), pathImportHandler);

// ---- GET /api/v1/cases/:caseId/imports/:importId — import status ------------
router.get('/cases/:caseId/imports/:importId', requireCaseRole('case_manager'), importStatusHandler);

// ---- GET /api/v1/cases/:caseId/documents — list/search documents -----------
// read_only+ on the case. Reuses the browser document-list handler (q, filters,
// pagination). Note the underlying handler reads req.params.caseId via caseId.
router.get('/cases/:caseId/documents', requireCaseRole('read_only'), listDocumentsHandler);

export default router;
