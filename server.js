require('dotenv').config();
const express = require('express');
const path = require('path');
const partsRouter = require('./routes/parts');
const authRouter = require('./routes/auth');
const ebayAuthRouter = require('./routes/ebayAuth');
const uploadsRouter = require('./routes/uploads');
const updatesRouter = require('./routes/updates');
const feedbackRouter = require('./routes/feedback');
const onboardingRouter = require('./routes/onboarding');
const { securityHeaders } = require('./middleware/securityHeaders');
const { pruneExpiredSessions } = require('./middleware/auth');
const db = require('./db');
const { pruneAiUsage } = require('./services/aiQuotaService');
const { startBackupSchedule } = require('./services/backupService');
const { isApiRequest, statusForError } = require('./services/errorPageService');

const app = express();
// This app always runs behind a reverse proxy (Cloudflare tunnel locally; the deployment host's
// proxy in production) - without this, req.ip resolves to the proxy's own address for every
// request, which would put every visitor into the same rate-limit bucket. "1" trusts exactly one
// hop (the immediate proxy in front of this app), not an arbitrary chain of forwarded headers.
app.set('trust proxy', 1);
app.use(securityHeaders);
app.use(express.json());
app.use('/uploads', uploadsRouter);
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', authRouter);
app.use('/api/ebay', ebayAuthRouter);
app.use('/api/parts', partsRouter);
app.use('/api/updates', updatesRouter);
app.use('/api/feedback', feedbackRouter);
app.use('/api/onboarding', onboardingRouter);

// Reached only if nothing above matched - JSON for API callers (matches every other route's
// error shape), a branded page for everyone else.
app.use((req, res) => {
  if (isApiRequest(req.path)) return res.status(404).json({ error: 'Not found' });
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// Generic error handler - must take all 4 args for Express to recognize it as one. Catches
// anything passed to next(err) (or thrown synchronously in a non-async handler) so a future bug
// gets a clean response instead of Express's default leaking a stack trace. The unused `next`
// param is required - Express only treats a 4-arg function as an error handler.
app.use((err, req, res, next) => {
  console.error(err);
  const status = statusForError(err);
  if (isApiRequest(req.path)) return res.status(status).json({ error: err.message || 'Internal server error' });
  res.status(status).sendFile(path.join(__dirname, 'public', '500.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Listing assistant running at http://localhost:${PORT}`);
});

// Expired sessions are pruned lazily one-at-a-time on lookup (see getSessionUser); this sweeps
// everything else so the table doesn't grow unbounded from sessions nobody ever presents again.
pruneExpiredSessions();
setInterval(pruneExpiredSessions, 60 * 60 * 1000);

// Same idea for the AI-draft usage log: rows older than the 24h window no longer affect any limit.
pruneAiUsage(db);
setInterval(() => pruneAiUsage(db), 60 * 60 * 1000);

// Daily off-site snapshot of the database to a private R2 bucket (no-op, with a log line, unless
// R2_BACKUP_BUCKET_NAME is configured) - see services/backupService.js.
startBackupSchedule(db);
