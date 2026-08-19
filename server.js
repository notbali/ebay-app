require('dotenv').config();
const express = require('express');
const path = require('path');
const partsRouter = require('./routes/parts');
const authRouter = require('./routes/auth');
const ebayAuthRouter = require('./routes/ebayAuth');
const uploadsRouter = require('./routes/uploads');
const { securityHeaders } = require('./middleware/securityHeaders');
const { pruneExpiredSessions } = require('./middleware/auth');

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Listing assistant running at http://localhost:${PORT}`);
});

// Expired sessions are pruned lazily one-at-a-time on lookup (see getSessionUser); this sweeps
// everything else so the table doesn't grow unbounded from sessions nobody ever presents again.
pruneExpiredSessions();
setInterval(pruneExpiredSessions, 60 * 60 * 1000);
